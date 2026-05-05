"""AI Data Genie — Streamlit Chat Interface."""

import os
import streamlit as st
import pandas as pd
import plotly.express as px
from dotenv import load_dotenv
from database import init_database
from genie_engine import GenieEngine

load_dotenv()

# ---------------------------------------------------------------------------
# Page config
# ---------------------------------------------------------------------------
st.set_page_config(
    page_title="AI Data Genie",
    page_icon="🧞",
    layout="wide",
)

# ---------------------------------------------------------------------------
# Styling
# ---------------------------------------------------------------------------
st.markdown("""
<style>
    .stApp { background-color: #0e1117; }
    .main-header {
        text-align: center;
        padding: 1rem 0 0.5rem 0;
    }
    .main-header h1 { font-size: 2.2rem; color: #c084fc; }
    .main-header p { color: #9ca3af; font-size: 1rem; }
    .sql-box {
        background-color: #1e1e2e;
        border: 1px solid #313244;
        border-radius: 8px;
        padding: 12px;
        font-family: monospace;
        font-size: 0.82rem;
        color: #cdd6f4;
        overflow-x: auto;
    }
    div[data-testid="stExpander"] details summary span { font-size: 0.85rem; }
</style>
""", unsafe_allow_html=True)

# ---------------------------------------------------------------------------
# Init
# ---------------------------------------------------------------------------
init_database()

api_key = os.getenv("ANTHROPIC_API_KEY", "")

# Sidebar
with st.sidebar:
    st.markdown("### ⚙️ Configuration")
    api_key_input = st.text_input(
        "Anthropic API Key",
        value=api_key,
        type="password",
        help="Get your key at console.anthropic.com",
    )
    if api_key_input:
        api_key = api_key_input

    st.markdown("---")
    st.markdown("### 💡 Example Questions")

    st.markdown("**Semiconductor BI**")
    semi_examples = [
        "What is the average yield by fab?",
        "Show me defect pareto by type",
        "Yield trend by month for 3nm process",
        "Which product has the highest revenue in APAC?",
        "Compare fab utilization across all fabs for 2024",
    ]
    for q in semi_examples:
        if st.button(q, key=f"semi_{q}"):
            st.session_state.pending_question = q

    st.markdown("**People Analytics**")
    people_examples = [
        "What is our current headcount by department?",
        "Show attrition rate by location",
        "Gender diversity breakdown by level",
        "Average engagement score trend by year",
        "Hiring funnel conversion rates by department",
        "Show compensation distribution by level",
    ]
    for q in people_examples:
        if st.button(q, key=f"ppl_{q}"):
            st.session_state.pending_question = q

    st.markdown("---")
    if st.button("🗑️ Clear Chat"):
        st.session_state.messages = []
        st.session_state.conversation_history = []
        st.rerun()

# ---------------------------------------------------------------------------
# Header
# ---------------------------------------------------------------------------
st.markdown("""
<div class="main-header">
    <h1>🧞 AI Data Genie</h1>
    <p>Ask questions about your semiconductor manufacturing or workforce data in plain English.</p>
</div>
""", unsafe_allow_html=True)

# ---------------------------------------------------------------------------
# Chat state
# ---------------------------------------------------------------------------
if "messages" not in st.session_state:
    st.session_state.messages = []
if "conversation_history" not in st.session_state:
    st.session_state.conversation_history = []

# ---------------------------------------------------------------------------
# Render function (defined before use)
# ---------------------------------------------------------------------------


def render_result(result: dict):
    """Render query results with visualization."""
    if not result.get("data"):
        return

    df = pd.DataFrame(result["data"])
    viz = result.get("visualization", "table")
    cfg = result.get("viz_config", {})

    # Auto-visualization
    if viz != "table" and len(df) > 0:
        try:
            chart_title = cfg.get("title", "")
            x = cfg.get("x", df.columns[0])
            y = cfg.get("y", df.columns[1] if len(df.columns) > 1 else df.columns[0])
            color = cfg.get("color")

            # Validate columns exist
            if x not in df.columns:
                x = df.columns[0]
            if y not in df.columns:
                y = df.columns[min(1, len(df.columns) - 1)]
            if color and color not in df.columns:
                color = None

            if viz == "bar":
                fig = px.bar(df, x=x, y=y, color=color, title=chart_title,
                             template="plotly_dark")
            elif viz == "line":
                fig = px.line(df, x=x, y=y, color=color, title=chart_title,
                              template="plotly_dark", markers=True)
            elif viz == "pie":
                fig = px.pie(df, names=x, values=y, title=chart_title,
                             template="plotly_dark")
            elif viz == "metric":
                cols = st.columns(min(len(df.columns), 4))
                for i, col_name in enumerate(df.columns[:4]):
                    with cols[i]:
                        val = df[col_name].iloc[0]
                        st.metric(label=col_name, value=f"{val:,.2f}" if isinstance(val, float) else str(val))
                fig = None
            else:
                fig = None

            if fig:
                fig.update_layout(
                    plot_bgcolor="rgba(0,0,0,0)",
                    paper_bgcolor="rgba(0,0,0,0)",
                    margin=dict(l=20, r=20, t=40, b=20),
                    height=400,
                )
                st.plotly_chart(fig, use_container_width=True)
        except Exception:
            pass  # Fall through to table

    # Always show data table in expander
    with st.expander(f"📊 Data ({len(df)} rows)", expanded=(viz == "table")):
        st.dataframe(df, use_container_width=True, hide_index=True)

    # Show SQL in expander
    if result.get("sql"):
        with st.expander("🔍 SQL Query"):
            st.markdown(f'<div class="sql-box">{result["sql"]}</div>', unsafe_allow_html=True)


# ---------------------------------------------------------------------------
# Render existing messages (replay on rerun)
# ---------------------------------------------------------------------------
for msg in st.session_state.messages:
    with st.chat_message(msg["role"], avatar="🧞" if msg["role"] == "assistant" else None):
        st.markdown(msg["content"])
        if msg["role"] == "assistant" and "result" in msg:
            render_result(msg["result"])

# ---------------------------------------------------------------------------
# Handle pending question from sidebar buttons
# ---------------------------------------------------------------------------
pending = st.session_state.pop("pending_question", None)

# ---------------------------------------------------------------------------
# Chat input
# ---------------------------------------------------------------------------
user_input = st.chat_input("Ask a question about your data...")
question = pending or user_input

if question:
    if not api_key:
        st.error("Please enter your Anthropic API key in the sidebar.")
        st.stop()

    # Display user message
    with st.chat_message("user"):
        st.markdown(question)
    st.session_state.messages.append({"role": "user", "content": question})

    # Get answer
    with st.chat_message("assistant", avatar="🧞"):
        with st.spinner("Analyzing your question..."):
            engine = GenieEngine(api_key=api_key)
            result = engine.ask(
                question,
                conversation_history=st.session_state.conversation_history[-10:],
            )

        if result.get("error") and not result.get("data"):
            st.error(result["explanation"])
        else:
            st.markdown(result["explanation"])
            render_result(result)

    # Save to state
    st.session_state.messages.append({
        "role": "assistant",
        "content": result["explanation"],
        "result": result,
    })
    st.session_state.conversation_history.append(
        {"role": "user", "content": question}
    )
    st.session_state.conversation_history.append(
        {"role": "assistant", "content": result["explanation"]}
    )
