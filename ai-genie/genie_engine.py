"""Claude-powered NL-to-SQL engine — the brain of the AI Genie."""

import json
import re
import anthropic
from database import execute_query, get_schema_description

SYSTEM_PROMPT = """You are an AI Data Genie — a business intelligence assistant that answers questions by querying a SQL database.

## Your Database Schema
{schema}

## Rules
1. ALWAYS generate a valid SQLite SQL query to answer the user's question.
2. Return your response as JSON with these fields:
   - "thinking": Brief explanation of your approach (1-2 sentences)
   - "sql": The SQL query to execute
   - "visualization": One of "table", "bar", "line", "pie", or "metric" — pick the best chart type
   - "viz_config": Object with "x" (column for x-axis), "y" (column for y-axis/value), "color" (optional grouping column), "title" (chart title)
3. Use aggregations, GROUP BY, JOINs as needed. Keep queries efficient.
4. For trend questions, order by date/time columns.
5. Format numbers nicely (ROUND, aliases with units).
6. If the question is ambiguous, make a reasonable assumption and note it in "thinking".
7. ONLY return the JSON object, no markdown fencing or extra text.

## Domain Context

### Semiconductor BI
- wafer_lots: Manufacturing data per lot. yield_pct is the key quality metric.
- defects: Defect inspection data linked to lots. High defect_count → low yield.
- fab_utilization: Monthly capacity vs actual production per fab.
- semiconductor_revenue: Quarterly revenue by product and region. ASP = average selling price.
- Common questions: yield trends, defect pareto, fab utilization, revenue by product/region.

### People Analytics
- employees: Workforce data. is_active=1 means current employee. termination_date NOT NULL means departed.
- hiring_funnel: Recruitment pipeline metrics per requisition.
- engagement_surveys: Employee satisfaction scores (1-5 scale).
- compensation_bands: Pay ranges by level and department.
- Common questions: headcount, attrition rate, diversity breakdown, hiring conversion, pay equity.
"""

EXPLAIN_PROMPT = """You are a business intelligence analyst. Given the user's question, the SQL query that was run, and the query results, provide a clear, insightful answer.

## Rules
1. Lead with the key finding — answer the question directly in the first sentence.
2. Call out notable patterns, outliers, or trends in the data.
3. If relevant, suggest a follow-up question the user might want to ask.
4. Keep it concise — 2-4 short paragraphs max.
5. Use specific numbers from the results. Format large numbers with commas.
6. Do NOT show the SQL query or mention SQL at all — speak in business terms.
"""


class GenieEngine:
    def __init__(self, api_key: str):
        self.client = anthropic.Anthropic(api_key=api_key)
        self.model = "claude-sonnet-4-6"

    def ask(self, question: str, conversation_history: list[dict] | None = None) -> dict:
        """Process a natural language question and return structured results."""
        schema = get_schema_description()

        # Step 1: Generate SQL
        messages = []
        if conversation_history:
            messages.extend(conversation_history)
        messages.append({"role": "user", "content": question})

        response = self.client.messages.create(
            model=self.model,
            max_tokens=1024,
            system=SYSTEM_PROMPT.format(schema=schema),
            messages=messages,
        )

        raw_text = response.content[0].text.strip()

        # Parse JSON from response (handle markdown fencing if present)
        json_text = raw_text
        fence_match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", raw_text, re.DOTALL)
        if fence_match:
            json_text = fence_match.group(1)

        try:
            plan = json.loads(json_text)
        except json.JSONDecodeError:
            return {
                "error": "Failed to parse query plan from Claude.",
                "raw": raw_text,
                "sql": None,
                "data": [],
                "explanation": "I had trouble understanding that question. Could you rephrase it?",
                "visualization": "table",
                "viz_config": {},
            }

        sql = plan.get("sql", "")
        viz = plan.get("visualization", "table")
        viz_config = plan.get("viz_config", {})
        thinking = plan.get("thinking", "")

        # Step 2: Execute SQL
        try:
            data = execute_query(sql)
        except Exception as e:
            return {
                "error": str(e),
                "sql": sql,
                "data": [],
                "explanation": f"The query failed: {e}. Let me try a different approach — could you rephrase your question?",
                "visualization": "table",
                "viz_config": {},
            }

        # Step 3: Generate natural language explanation
        explain_messages = [
            {
                "role": "user",
                "content": (
                    f"User question: {question}\n\n"
                    f"SQL executed: {sql}\n\n"
                    f"Results ({len(data)} rows): {json.dumps(data[:50], default=str)}"
                ),
            }
        ]

        explain_response = self.client.messages.create(
            model=self.model,
            max_tokens=1024,
            system=EXPLAIN_PROMPT,
            messages=explain_messages,
        )

        explanation = explain_response.content[0].text.strip()

        return {
            "sql": sql,
            "data": data,
            "explanation": explanation,
            "visualization": viz,
            "viz_config": viz_config,
            "thinking": thinking,
            "error": None,
        }
