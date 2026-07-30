#include <napi.h>

typedef struct TSLanguage TSLanguage;

extern "C" TSLanguage *tree_sitter_lua();

// "tree-sitter", "language" hashed with BLAKE2 — the type tag every tree-sitter
// grammar's language external carries; the tree-sitter@0.21.1 runtime's
// Parser.setLanguage checks it to validate the language object.
const napi_type_tag LANGUAGE_TYPE_TAG = {
  0x8AF2E5212AD58ABF, 0xD5006CAD83ABBA16
};

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports["name"] = Napi::String::New(env, "lua");
    auto language = Napi::External<TSLanguage>::New(env, tree_sitter_lua());
    language.TypeTag(&LANGUAGE_TYPE_TAG);
    exports["language"] = language;
    return exports;
}

NODE_API_MODULE(tree_sitter_lua_binding, Init)
