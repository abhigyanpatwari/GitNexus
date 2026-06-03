package app;

// Interface-to-interface EXTENDS (#1951). `interface IA extends IB, IC<String>`
// lives under `interface_declaration > extends_interfaces > type_list`, which
// the registry-primary synth previously NEVER walked (it visited
// class_declaration only) — so production silently dropped these edges while the
// legacy @heritage `interface_declaration` arm emitted them. Both bases resolve
// to Interface symbols, so the edges are emitted as IMPLEMENTS at both legs.
// IC<String> exercises the generic-base reduction (IC<String> -> IC), matching
// normalizeSupertypeName.
public interface IA extends IB, IC<String> {
    void a();
}
