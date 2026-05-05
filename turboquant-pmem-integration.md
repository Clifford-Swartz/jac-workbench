# TurboQuant × pmem-tier Integration Design

## Thesis

TurboQuant (Google Research, ICLR 2026) achieves ~5x KV cache compression at near-zero quality loss by rotating vectors into a basis where scalar quantization is near-optimal. Integrating this into pmem-tier's userfaultfd-based NAND tiering creates a multiplicative win: fewer page faults, less write amplification, and dramatically extended effective memory capacity for long-context MoE inference.

## Why This Matters for pmem-tier

Current pmem-tier benchmarks on DeepSeek V3 671B show ~5.5 min TTFT with TinyLFU admission. The dominant bottleneck is NAND I/O for KV cache pages during long-context inference. KV cache grows linearly with sequence length — at 128K context it dwarfs the model weights in active memory pressure.

TurboQuant compresses KV entries 5x *before* they enter the memory hierarchy. The gains compound with existing optimizations:

- **TinyLFU + TurboQuant**: 17–21x fewer NAND writes (TinyLFU) × 5x smaller payloads = ~85–105x effective write reduction vs naive LRU with uncompressed KV
- **MoE-aware prefetch + TurboQuant**: Prefetched expert KV blocks are 5x smaller, so prefetch bandwidth goes 5x further
- **CXL projection**: The ~45s TTFT target at 25 GB/s becomes even more achievable — same bandwidth, 5x less data to move

## TurboQuant Algorithm Summary

```
INIT (once per model):
  Π = random_orthogonal_matrix(d)        # d = head_dim, typically 128
  codebook = lloyd_max(Beta(d), bits=b)   # precomputed centroids per bit-width

QUANTIZE(v):
  y = Π @ v                              # rotate into uniform-coordinate basis
  indices = nearest(y, codebook)          # scalar quantize each coordinate
  return indices                          # store as packed integers

DEQUANTIZE(indices):
  y = codebook[indices]                   # look up centroids
  v̂ = Πᵀ @ y                             # rotate back to original basis
  return v̂
```

The rotation makes coordinates follow a Beta distribution (≈ Gaussian at typical d=128), so a single precomputed Lloyd-Max codebook works for all vectors regardless of input distribution. No calibration, no training, no per-model tuning.

## Integration Architecture

### Option A: Compress Everything (Recommended)

```
┌─────────────────────────────────────────────────┐
│  Inference Engine (vLLM / llama.cpp)            │
│  KV write path:  v → TQ_quantize(v) → store    │
│  KV read path:   load → TQ_dequantize → attn   │
└──────────────────┬──────────────────────────────┘
                   │ compressed KV entries
          ┌────────▼────────┐
          │   pmem-tier      │
          │                  │
          │  DRAM tier:      │
          │  compressed KV   │
          │  (TinyLFU)       │
          │        │         │
          │  NAND tier:      │
          │  compressed KV   │
          │  (userfaultfd)   │
          └──────────────────┘
```

**Pros:**
- Simple — one format everywhere, no conversion on eviction
- 5x more effective DRAM capacity (hot set grows 5x)
- Fewer page faults overall since more entries fit in DRAM
- TinyLFU admission decisions unchanged

**Cons:**
- All attention computations use dequantized values (minor precision cost)
- Quantize/dequantize on every read/write (but this is ~μs vs ~ms for NAND I/O)

### Option B: Compress on Eviction Only

```
┌─────────────────────────────────────────────────┐
│  Inference Engine                               │
│  KV write/read: full precision FP16             │
└──────────────────┬──────────────────────────────┘
                   │ FP16 KV entries
          ┌────────▼────────┐
          │   pmem-tier      │
          │                  │
          │  DRAM tier:      │
          │  FP16 (full)     │
          │  (TinyLFU)       │
          │        │ evict: TQ_quantize            │
          │        │ promote: TQ_dequantize         │
          │  NAND tier:      │
          │  compressed KV   │
          │  (userfaultfd)   │
          └──────────────────┘
```

**Pros:**
- Zero precision loss for hot (DRAM-resident) entries
- Quantize cost hidden behind NAND latency on eviction

**Cons:**
- DRAM capacity unchanged — same page fault rate
- Complexity in the userfaultfd handler (format conversion during fault)
- Only helps NAND capacity and bandwidth, not DRAM pressure

**Recommendation:** Option A. The precision loss at 3-bit TurboQuant is empirically negligible (99.5% attention cosine similarity), and the 5x DRAM capacity expansion is too valuable to leave on the table. The dominant bottleneck is page faults, and Option A directly reduces them.

## Implementation Plan

### Phase 1: Standalone Validation

1. Port TurboQuant quantize/dequantize to C (or adapt existing llama.cpp community implementation)
2. Precompute Lloyd-Max codebooks for d=128 (DeepSeek V3 head dim) at 3-bit and 4-bit
3. Generate rotation matrix Π via QR decomposition of Gaussian matrix, store as static binary blob
4. Validate MSE and inner-product cosine similarity against paper's reported numbers
5. Benchmark quantize/dequantize throughput — target < 10μs per vector (negligible vs NAND latency)

### Phase 2: pmem-tier Integration

1. Add `tq_quantize()` / `tq_dequantize()` calls in the KV page write/read paths
2. Modify page size constants — compressed pages are ~5x smaller, so either:
   - Keep same page granularity, pack 5x more KV entries per page (better spatial locality)
   - Reduce page size 5x (fewer wasted bytes on partial pages, but more metadata)
3. Update TinyLFU frequency counters — same key space, just smaller values behind the keys
4. Test with DeepSeek V3 671B at 32K and 128K context lengths

### Phase 3: Kernel Optimization

1. SIMD-optimized rotation (AVX-512 for the matrix multiply — Π is dense but constant)
2. Bit-packing for 3-bit indices (48 bytes per 128-dim vector vs 256 bytes FP16)
3. Optional: fused quantize-and-write kernel to avoid intermediate buffer
4. Optional: GPU-side quantize if KV is generated on GPU before transfer to host tiers

### Phase 4: Benchmark & Patent Update

1. Full A/B benchmark: pmem-tier with and without TurboQuant
2. Key metrics: TTFT, page fault rate, NAND write volume, effective memory capacity
3. Expected results:
   - TTFT improvement: 2–3x (fewer faults + smaller transfers)
   - NAND write volume: ~5x reduction (on top of TinyLFU gains)
   - Effective DRAM capacity: ~5x for KV cache entries
4. Update provisional patent application with TurboQuant-aware tiering as specific embodiment

## Memory Layout

### Compressed KV Page (3-bit, d=128)

```
┌──────────────────────────────────────┐
│ Header (8 bytes)                     │
│   - page_id: u32                     │
│   - entry_count: u16                 │
│   - bit_width: u8                    │
│   - flags: u8                        │
├──────────────────────────────────────┤
│ Entry 0 (52 bytes)                   │
│   - norm: f32 (4 bytes)              │
│   - packed_indices: 48 bytes         │
│     (128 × 3 bits = 384 bits)        │
├──────────────────────────────────────┤
│ Entry 1 (52 bytes)                   │
│   ...                                │
├──────────────────────────────────────┤
│ Entry N                              │
└──────────────────────────────────────┘

Compression: 52 bytes vs 256 bytes (FP16) = 4.9x
```

### Comparison: Entries per 4KB Page

| Format | Bytes/Entry | Entries/Page | Effective Capacity |
|--------|------------|-------------|-------------------|
| FP16   | 256        | 16          | 1x                |
| TQ3    | 52         | 78          | 4.9x              |
| TQ4    | 68         | 60          | 3.8x              |

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Precision loss compounds across layers at 3-bit | Low | High | Validate per-layer attention similarity; fall back to 4-bit for sensitive layers |
| Rotation matrix multiply bottleneck on CPU | Low | Medium | AVX-512 GEMV is fast for d=128; Π is constant so can be in L1 cache |
| MoE expert activation changes quantization statistics | Low | Low | TurboQuant is data-oblivious by design — codebook doesn't depend on input distribution |
| Patent overlap with Google's TurboQuant IP | Medium | High | Our patent covers the tiering system, not the quantization algorithm; TurboQuant is the compression codec within our architecture |

## Open Questions

1. **Bit-width selection per tier**: Should DRAM use 4-bit (higher fidelity) and NAND use 3-bit (higher compression)? This gives a precision gradient that matches access frequency.
2. **QJL residual stage**: The full TurboQuant includes a 1-bit QJL sketch for unbiased inner products. Is the extra bit worth it for our use case, or is MSE-only sufficient since we dequantize before attention?
3. **Integration with MoE-aware prefetch**: When prefetching expert KV blocks, should we dequantize eagerly into DRAM or keep compressed and dequantize on demand?
4. **Rotation matrix per-layer vs global**: Paper uses one Π per head dimension. Worth testing if per-layer rotation improves quality at the cost of more stored matrices (negligible memory — one 128×128 matrix = 64KB).

## References

- Zandieh et al., "TurboQuant: Online Vector Quantization with Near-optimal Distortion Rate," ICLR 2026. arXiv:2504.19874
- Google Research Blog: research.google/blog/turboquant-redefining-ai-efficiency-with-extreme-compression/
- llama.cpp integration discussion: github.com/ggml-org/llama.cpp/discussions/20969
- Community Apple Silicon implementation: github.com/TheTom/turboquant_plus
