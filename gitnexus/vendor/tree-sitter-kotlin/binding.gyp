{
  "targets": [
    {
      "target_name": "tree_sitter_kotlin_binding",
      "dependencies": [
        "<!(node -p \"require('node-addon-api').targets\"):node_addon_api_except",
      ],
      "include_dirs": [
        "src",
      ],
      "sources": [
        "bindings/node/binding.cc",
        "src/parser.c",
        "src/scanner.c"
      ],
      "conditions": [
        ["OS!='win'", {
          "cflags_c": [
            "-std=c11",
          ],
        }, { # OS == "win"
          # cflags_c is not forwarded by the MSVS generator. The scanner's
          # _Static_assert requires C11 even when the rest of the C compiles.
          "msvs_settings": {
            "VCCLCompilerTool": {
              "AdditionalOptions": ["/std:c11", "/utf-8"],
            },
          },
        }],
      ],
    }
  ]
}
