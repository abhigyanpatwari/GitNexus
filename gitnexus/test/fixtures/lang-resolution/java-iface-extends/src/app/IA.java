package app;

// Interface-to-interface EXTENDS (#1951). `interface IA extends IB, IC<String>`
// lives under `interface_declaration > extends_interfaces > type_list`, which
// an earlier synth NEVER walked (it visited class_declaration only) — so
// production silently dropped these edges. Both bases resolve to Interface
// symbols, so the edges are emitted as IMPLEMENTS. IC<String> exercises the
// generic-base reduction (IC<String> -> IC). Scope-resolution owns these edges
// since #942.
public interface IA extends IB, IC<String> {
    void a();
}
