# Primary sources, decisions and assumptions

Reviewed 6 October 2026. Source facts below are time-sensitive; operational limits elsewhere are this project's proposed defaults. Source pages can change, so runtime revisions must be pinned during implementation.

## Source register

| ID | Primary source | Relevance |
| --- | --- | --- |
| S1 | [receptron/laya README](https://github.com/receptron/laya) | Node/ONNX adapter, English state and options limits, model loading |
| S2 | [Cloudflare Clef-flash model card](https://huggingface.co/Cloudflare/clef-flash) | Typed decision model and joint schema head |
| S3 | [GGML Clef-flash GGUF](https://huggingface.co/ggml-org/Clef-Flash-GGUF) and [llama.cpp support PR](https://github.com/ggml-org/llama.cpp/pull/29831) | Quantisation candidate and dedicated SystemOne endpoint |
| S4 | [Linux rename(2)](https://man7.org/linux/man-pages/man2/rename.2.html) | RENAME_NOREPLACE, error behaviour and filesystem semantics |
| S5 | [Linux openat2(2)](https://man7.org/linux/man-pages/man2/openat2.2.html) | Anchored resolution and symlink/mount restrictions |
| S6 | [TypeSafe introduction](https://docs.typesafe.ai/introduction) and [confidence](https://docs.typesafe.ai/confidence) | Typed questions and distinction between confidence and decisions |
| S7 | [OpenCode skills](https://opencode.ai/docs/skills/) | Supported SKILL.md discovery |
| S8 | [OpenCode MCP servers](https://opencode.ai/docs/mcp-servers/) and [agents](https://opencode.ai/docs/agents/) | Harness integration and permission configuration |
| S9 | [MCP security guidance](https://modelcontextprotocol.io/docs/2025-11-25/tutorials/security/security_best_practices) | Future tool boundary and authorisation |
| S10 | [Vite guide](https://vite.dev/guide/) and [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | Local UI build and SQLite adapter prerequisites |
| S11 | [SQLite pragmas](https://www.sqlite.org/pragma.html) | Foreign keys, WAL and synchronous settings |
| S12 | [Google Drive folder operations](https://developers.google.com/workspace/drive/api/guides/folder) | Future parent-ID move semantics |
| S13 | [GitHub starring API](https://docs.github.com/en/rest/activity/starring) | Starred-repository discovery; separate list writes require verification |
| S14 | [X bookmarks](https://docs.x.com/x-api/posts/bookmarks/introduction) | Bookmark and folder lookup; account access remains a later prerequisite |

## Verified facts used in the design

Laya's selected Node package runs the Convai model through ONNX. Its README describes approximately 1.7 GB FP32 weights, roughly 2 GB loaded RAM plus overhead, English state max_len of 512 and head_max_len of 192. It recommends relatively small choice sets. These are package/checkpoint constraints, not measured laptop performance. Check the actual pinned model configuration. [S1]

Clef-flash is a 9B typed-decision model derived from Qwen3.5-9B, with a joint schema head. GGML's model card lists Q4_K_M at 6.49 GB and directs inference to `/v1/systemone`. The linked llama.cpp support change merged on 3 October 2026. Generic chat-loading instructions are not evidence that a locally installed tool implements that endpoint. [S2–S3]

Jev documentation describes choice, score and yes/no primitives. Its confidence is derived from reported distributions; model confidence should not replace policy or runtime approval. Local domain calibration still needs measurement. [S6]

Linux renameat2's no-replace operation protects an existing destination atomically; openat2 provides restrictive anchored resolution options. Neither supplies an atomic condition that the source inode equals an application-specified snapshot during rename. The project therefore distinguishes kernel containment/no-overwrite guarantees from source-change detection and reconciliation. [S4–S5]

## Decision register

| ID | Decision | Reason / consequence |
| --- | --- | --- |
| D01 | Modular local application | Reuse core without distributed operations |
| D02 | Downloads inbox and destination boundary | Direct user selection |
| D03 | Existing categories plus reviewed additions | Direct user selection; category approval precedes move approval |
| D04 | Manual batch review | Prior user decision; confidence cannot grant write permission |
| D05 | Laya/Clef independent baseline | Determine provider order empirically |
| D06 | Hierarchical typed choice, max seven children plus unknown | Accommodate small header/context limits without hidden shortlist bias |
| D07 | Rust filesystem helper | Keep Linux syscall safety in one tested module |
| D08 | Same-mount moves only | Avoid copy/delete failure states in first release |
| D09 | Text/metadata first | Fair local comparison; OCR/multimodal later |
| D10 | SQLite durable journal | Sufficient for single-user batches; no database server |
| D11 | MCP adapter later, read tools first | Reuse policies; avoid parallel write paths |
| D12 | OpenCode execution, Codex review | Direct user workflow; model choices recorded per milestone |

## Assumptions and installation gates

| Item | Treatment |
| --- | --- |
| Actual Downloads path | Resolve with XDG and confirm during app setup |
| Exact folder tree and document mix | Discovered read-only on the laptop; this pack uses synthetic examples |
| CPU/RAM/GPU and Clef capacity | User's Fedora i7/32 GB context informs planning; measure current hardware and available memory |
| Local Clef runtime | Probe SystemOne response and pin build; no assumed Ollama/LM Studio support |
| Dependency versions | Verify Node/Cargo compatibility and pin lockfiles at setup |
| Native syscall/filesystem support | Probe and run fixture tests; unsupported apply is disabled |
| User labels and thresholds | Built on local development/calibration data; no claims of universal calibration |
| External account/API permissions | Later adapter-specific discovery; no account connection performed here |

New detailed defaults in the PRD/spec are proposals for review even though the architecture direction is approved. No measured benchmarks or real-file execution were performed. The mockup shows synthetic data. Metadata/provenance is documented in README.

