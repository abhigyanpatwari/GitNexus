# ⚙️ SPEC: TASK 2.01 - NEXUS BUTTON (ATOM)

**Scope:** Primary interactive primitive.
**State Machine:**
- `Idle`: `bg-zinc-900 text-zinc-100 border-zinc-800`
- `Hover`: `border-orange-500 text-orange-500 bg-orange-900/10`
- `Loading`: Disable interaction, render spinner icon.
- `Disabled`: `opacity-50 cursor-not-allowed text-zinc-500`
**Contract:** Must accept `label` (string), `onClick` (function), `isLoading` (boolean), `icon` (optional component).
**Prohibited:** Cannot fetch data. Cannot hold global state.
