#include "tree_sitter/parser.h"

#if defined(__GNUC__) || defined(__clang__)
#pragma GCC diagnostic ignored "-Wmissing-field-initializers"
#endif

#ifdef _MSC_VER
#pragma optimize("", off)
#elif defined(__clang__)
#pragma clang optimize off
#elif defined(__GNUC__)
#pragma GCC optimize ("O0")
#endif

#define LANGUAGE_VERSION 14
#define STATE_COUNT 345
#define LARGE_STATE_COUNT 2
#define SYMBOL_COUNT 133
#define ALIAS_COUNT 0
#define TOKEN_COUNT 73
#define EXTERNAL_TOKEN_COUNT 0
#define FIELD_COUNT 2
#define MAX_ALIAS_SEQUENCE_LENGTH 14
#define PRODUCTION_ID_COUNT 4

enum ts_symbol_identifiers {
  anon_sym_SEMI = 1,
  anon_sym_edition = 2,
  anon_sym_EQ = 3,
  anon_sym_syntax = 4,
  anon_sym_DQUOTEproto3_DQUOTE = 5,
  anon_sym_DQUOTEproto2_DQUOTE = 6,
  anon_sym_import = 7,
  anon_sym_weak = 8,
  anon_sym_public = 9,
  anon_sym_option = 10,
  anon_sym_package = 11,
  anon_sym_LPAREN = 12,
  anon_sym_RPAREN = 13,
  anon_sym_DOT = 14,
  anon_sym_export = 15,
  anon_sym_local = 16,
  anon_sym_enum = 17,
  anon_sym_LBRACE = 18,
  anon_sym_RBRACE = 19,
  anon_sym_DASH = 20,
  anon_sym_LBRACK = 21,
  anon_sym_COMMA = 22,
  anon_sym_RBRACK = 23,
  anon_sym_message = 24,
  anon_sym_extend = 25,
  anon_sym_optional = 26,
  anon_sym_required = 27,
  anon_sym_repeated = 28,
  anon_sym_group = 29,
  anon_sym_oneof = 30,
  anon_sym_map = 31,
  anon_sym_LT = 32,
  anon_sym_GT = 33,
  anon_sym_int32 = 34,
  anon_sym_int64 = 35,
  anon_sym_uint32 = 36,
  anon_sym_uint64 = 37,
  anon_sym_sint32 = 38,
  anon_sym_sint64 = 39,
  anon_sym_fixed32 = 40,
  anon_sym_fixed64 = 41,
  anon_sym_sfixed32 = 42,
  anon_sym_sfixed64 = 43,
  anon_sym_bool = 44,
  anon_sym_string = 45,
  anon_sym_double = 46,
  anon_sym_float = 47,
  anon_sym_bytes = 48,
  anon_sym_reserved = 49,
  anon_sym_extensions = 50,
  anon_sym_to = 51,
  anon_sym_max = 52,
  anon_sym_service = 53,
  anon_sym_rpc = 54,
  anon_sym_stream = 55,
  anon_sym_returns = 56,
  anon_sym_PLUS = 57,
  anon_sym_COLON = 58,
  sym_identifier = 59,
  sym_reserved_identifier = 60,
  sym_true = 61,
  sym_false = 62,
  sym_decimal_lit = 63,
  sym_octal_lit = 64,
  sym_hex_lit = 65,
  sym_float_lit = 66,
  anon_sym_DQUOTE = 67,
  aux_sym_string_token1 = 68,
  anon_sym_SQUOTE = 69,
  aux_sym_string_token2 = 70,
  sym_escape_sequence = 71,
  sym_comment = 72,
  sym_source_file = 73,
  sym_empty_statement = 74,
  sym_edition = 75,
  sym_syntax = 76,
  sym_import = 77,
  sym_package = 78,
  sym_option = 79,
  sym__option_name = 80,
  sym_enum = 81,
  sym_enum_name = 82,
  sym_enum_body = 83,
  sym_enum_field = 84,
  sym_enum_value_option = 85,
  sym_message = 86,
  sym_message_body = 87,
  sym_message_name = 88,
  sym_extend = 89,
  sym_group = 90,
  sym_field = 91,
  sym_field_options = 92,
  sym_field_option = 93,
  sym_oneof = 94,
  sym_oneof_field = 95,
  sym_map_field = 96,
  sym_key_type = 97,
  sym_type = 98,
  sym_reserved = 99,
  sym_extensions = 100,
  sym_ranges = 101,
  sym_range = 102,
  sym_reserved_field_names = 103,
  sym_message_or_enum_type = 104,
  sym_field_number = 105,
  sym_service = 106,
  sym_service_name = 107,
  sym_rpc = 108,
  sym_rpc_name = 109,
  sym_constant = 110,
  sym_block_lit = 111,
  sym_full_ident = 112,
  sym_bool = 113,
  sym_int_lit = 114,
  sym_string = 115,
  aux_sym_source_file_repeat1 = 116,
  aux_sym__option_name_repeat1 = 117,
  aux_sym_enum_body_repeat1 = 118,
  aux_sym_enum_field_repeat1 = 119,
  aux_sym_message_body_repeat1 = 120,
  aux_sym_field_options_repeat1 = 121,
  aux_sym_oneof_repeat1 = 122,
  aux_sym_ranges_repeat1 = 123,
  aux_sym_reserved_field_names_repeat1 = 124,
  aux_sym_message_or_enum_type_repeat1 = 125,
  aux_sym_service_repeat1 = 126,
  aux_sym_rpc_repeat1 = 127,
  aux_sym_block_lit_repeat1 = 128,
  aux_sym_block_lit_repeat2 = 129,
  aux_sym_string_repeat1 = 130,
  aux_sym_string_repeat2 = 131,
  aux_sym_string_repeat3 = 132,
};

static const char * const ts_symbol_names[] = {
  [ts_builtin_sym_end] = "end",
  [anon_sym_SEMI] = ";",
  [anon_sym_edition] = "edition",
  [anon_sym_EQ] = "=",
  [anon_sym_syntax] = "syntax",
  [anon_sym_DQUOTEproto3_DQUOTE] = "\"proto3\"",
  [anon_sym_DQUOTEproto2_DQUOTE] = "\"proto2\"",
  [anon_sym_import] = "import",
  [anon_sym_weak] = "weak",
  [anon_sym_public] = "public",
  [anon_sym_option] = "option",
  [anon_sym_package] = "package",
  [anon_sym_LPAREN] = "(",
  [anon_sym_RPAREN] = ")",
  [anon_sym_DOT] = ".",
  [anon_sym_export] = "export",
  [anon_sym_local] = "local",
  [anon_sym_enum] = "enum",
  [anon_sym_LBRACE] = "{",
  [anon_sym_RBRACE] = "}",
  [anon_sym_DASH] = "-",
  [anon_sym_LBRACK] = "[",
  [anon_sym_COMMA] = ",",
  [anon_sym_RBRACK] = "]",
  [anon_sym_message] = "message",
  [anon_sym_extend] = "extend",
  [anon_sym_optional] = "optional",
  [anon_sym_required] = "required",
  [anon_sym_repeated] = "repeated",
  [anon_sym_group] = "group",
  [anon_sym_oneof] = "oneof",
  [anon_sym_map] = "map",
  [anon_sym_LT] = "<",
  [anon_sym_GT] = ">",
  [anon_sym_int32] = "int32",
  [anon_sym_int64] = "int64",
  [anon_sym_uint32] = "uint32",
  [anon_sym_uint64] = "uint64",
  [anon_sym_sint32] = "sint32",
  [anon_sym_sint64] = "sint64",
  [anon_sym_fixed32] = "fixed32",
  [anon_sym_fixed64] = "fixed64",
  [anon_sym_sfixed32] = "sfixed32",
  [anon_sym_sfixed64] = "sfixed64",
  [anon_sym_bool] = "bool",
  [anon_sym_string] = "string",
  [anon_sym_double] = "double",
  [anon_sym_float] = "float",
  [anon_sym_bytes] = "bytes",
  [anon_sym_reserved] = "reserved",
  [anon_sym_extensions] = "extensions",
  [anon_sym_to] = "to",
  [anon_sym_max] = "max",
  [anon_sym_service] = "service",
  [anon_sym_rpc] = "rpc",
  [anon_sym_stream] = "stream",
  [anon_sym_returns] = "returns",
  [anon_sym_PLUS] = "+",
  [anon_sym_COLON] = ":",
  [sym_identifier] = "identifier",
  [sym_reserved_identifier] = "reserved_identifier",
  [sym_true] = "true",
  [sym_false] = "false",
  [sym_decimal_lit] = "decimal_lit",
  [sym_octal_lit] = "octal_lit",
  [sym_hex_lit] = "hex_lit",
  [sym_float_lit] = "float_lit",
  [anon_sym_DQUOTE] = "\"",
  [aux_sym_string_token1] = "string_token1",
  [anon_sym_SQUOTE] = "'",
  [aux_sym_string_token2] = "string_token2",
  [sym_escape_sequence] = "escape_sequence",
  [sym_comment] = "comment",
  [sym_source_file] = "source_file",
  [sym_empty_statement] = "empty_statement",
  [sym_edition] = "edition",
  [sym_syntax] = "syntax",
  [sym_import] = "import",
  [sym_package] = "package",
  [sym_option] = "option",
  [sym__option_name] = "_option_name",
  [sym_enum] = "enum",
  [sym_enum_name] = "enum_name",
  [sym_enum_body] = "enum_body",
  [sym_enum_field] = "enum_field",
  [sym_enum_value_option] = "enum_value_option",
  [sym_message] = "message",
  [sym_message_body] = "message_body",
  [sym_message_name] = "message_name",
  [sym_extend] = "extend",
  [sym_group] = "group",
  [sym_field] = "field",
  [sym_field_options] = "field_options",
  [sym_field_option] = "field_option",
  [sym_oneof] = "oneof",
  [sym_oneof_field] = "oneof_field",
  [sym_map_field] = "map_field",
  [sym_key_type] = "key_type",
  [sym_type] = "type",
  [sym_reserved] = "reserved",
  [sym_extensions] = "extensions",
  [sym_ranges] = "ranges",
  [sym_range] = "range",
  [sym_reserved_field_names] = "reserved_field_names",
  [sym_message_or_enum_type] = "message_or_enum_type",
  [sym_field_number] = "field_number",
  [sym_service] = "service",
  [sym_service_name] = "service_name",
  [sym_rpc] = "rpc",
  [sym_rpc_name] = "rpc_name",
  [sym_constant] = "constant",
  [sym_block_lit] = "block_lit",
  [sym_full_ident] = "full_ident",
  [sym_bool] = "bool",
  [sym_int_lit] = "int_lit",
  [sym_string] = "string",
  [aux_sym_source_file_repeat1] = "source_file_repeat1",
  [aux_sym__option_name_repeat1] = "_option_name_repeat1",
  [aux_sym_enum_body_repeat1] = "enum_body_repeat1",
  [aux_sym_enum_field_repeat1] = "enum_field_repeat1",
  [aux_sym_message_body_repeat1] = "message_body_repeat1",
  [aux_sym_field_options_repeat1] = "field_options_repeat1",
  [aux_sym_oneof_repeat1] = "oneof_repeat1",
  [aux_sym_ranges_repeat1] = "ranges_repeat1",
  [aux_sym_reserved_field_names_repeat1] = "reserved_field_names_repeat1",
  [aux_sym_message_or_enum_type_repeat1] = "message_or_enum_type_repeat1",
  [aux_sym_service_repeat1] = "service_repeat1",
  [aux_sym_rpc_repeat1] = "rpc_repeat1",
  [aux_sym_block_lit_repeat1] = "block_lit_repeat1",
  [aux_sym_block_lit_repeat2] = "block_lit_repeat2",
  [aux_sym_string_repeat1] = "string_repeat1",
  [aux_sym_string_repeat2] = "string_repeat2",
  [aux_sym_string_repeat3] = "string_repeat3",
};

static const TSSymbol ts_symbol_map[] = {
  [ts_builtin_sym_end] = ts_builtin_sym_end,
  [anon_sym_SEMI] = anon_sym_SEMI,
  [anon_sym_edition] = anon_sym_edition,
  [anon_sym_EQ] = anon_sym_EQ,
  [anon_sym_syntax] = anon_sym_syntax,
  [anon_sym_DQUOTEproto3_DQUOTE] = anon_sym_DQUOTEproto3_DQUOTE,
  [anon_sym_DQUOTEproto2_DQUOTE] = anon_sym_DQUOTEproto2_DQUOTE,
  [anon_sym_import] = anon_sym_import,
  [anon_sym_weak] = anon_sym_weak,
  [anon_sym_public] = anon_sym_public,
  [anon_sym_option] = anon_sym_option,
  [anon_sym_package] = anon_sym_package,
  [anon_sym_LPAREN] = anon_sym_LPAREN,
  [anon_sym_RPAREN] = anon_sym_RPAREN,
  [anon_sym_DOT] = anon_sym_DOT,
  [anon_sym_export] = anon_sym_export,
  [anon_sym_local] = anon_sym_local,
  [anon_sym_enum] = anon_sym_enum,
  [anon_sym_LBRACE] = anon_sym_LBRACE,
  [anon_sym_RBRACE] = anon_sym_RBRACE,
  [anon_sym_DASH] = anon_sym_DASH,
  [anon_sym_LBRACK] = anon_sym_LBRACK,
  [anon_sym_COMMA] = anon_sym_COMMA,
  [anon_sym_RBRACK] = anon_sym_RBRACK,
  [anon_sym_message] = anon_sym_message,
  [anon_sym_extend] = anon_sym_extend,
  [anon_sym_optional] = anon_sym_optional,
  [anon_sym_required] = anon_sym_required,
  [anon_sym_repeated] = anon_sym_repeated,
  [anon_sym_group] = anon_sym_group,
  [anon_sym_oneof] = anon_sym_oneof,
  [anon_sym_map] = anon_sym_map,
  [anon_sym_LT] = anon_sym_LT,
  [anon_sym_GT] = anon_sym_GT,
  [anon_sym_int32] = anon_sym_int32,
  [anon_sym_int64] = anon_sym_int64,
  [anon_sym_uint32] = anon_sym_uint32,
  [anon_sym_uint64] = anon_sym_uint64,
  [anon_sym_sint32] = anon_sym_sint32,
  [anon_sym_sint64] = anon_sym_sint64,
  [anon_sym_fixed32] = anon_sym_fixed32,
  [anon_sym_fixed64] = anon_sym_fixed64,
  [anon_sym_sfixed32] = anon_sym_sfixed32,
  [anon_sym_sfixed64] = anon_sym_sfixed64,
  [anon_sym_bool] = anon_sym_bool,
  [anon_sym_string] = anon_sym_string,
  [anon_sym_double] = anon_sym_double,
  [anon_sym_float] = anon_sym_float,
  [anon_sym_bytes] = anon_sym_bytes,
  [anon_sym_reserved] = anon_sym_reserved,
  [anon_sym_extensions] = anon_sym_extensions,
  [anon_sym_to] = anon_sym_to,
  [anon_sym_max] = anon_sym_max,
  [anon_sym_service] = anon_sym_service,
  [anon_sym_rpc] = anon_sym_rpc,
  [anon_sym_stream] = anon_sym_stream,
  [anon_sym_returns] = anon_sym_returns,
  [anon_sym_PLUS] = anon_sym_PLUS,
  [anon_sym_COLON] = anon_sym_COLON,
  [sym_identifier] = sym_identifier,
  [sym_reserved_identifier] = sym_reserved_identifier,
  [sym_true] = sym_true,
  [sym_false] = sym_false,
  [sym_decimal_lit] = sym_decimal_lit,
  [sym_octal_lit] = sym_octal_lit,
  [sym_hex_lit] = sym_hex_lit,
  [sym_float_lit] = sym_float_lit,
  [anon_sym_DQUOTE] = anon_sym_DQUOTE,
  [aux_sym_string_token1] = aux_sym_string_token1,
  [anon_sym_SQUOTE] = anon_sym_SQUOTE,
  [aux_sym_string_token2] = aux_sym_string_token2,
  [sym_escape_sequence] = sym_escape_sequence,
  [sym_comment] = sym_comment,
  [sym_source_file] = sym_source_file,
  [sym_empty_statement] = sym_empty_statement,
  [sym_edition] = sym_edition,
  [sym_syntax] = sym_syntax,
  [sym_import] = sym_import,
  [sym_package] = sym_package,
  [sym_option] = sym_option,
  [sym__option_name] = sym__option_name,
  [sym_enum] = sym_enum,
  [sym_enum_name] = sym_enum_name,
  [sym_enum_body] = sym_enum_body,
  [sym_enum_field] = sym_enum_field,
  [sym_enum_value_option] = sym_enum_value_option,
  [sym_message] = sym_message,
  [sym_message_body] = sym_message_body,
  [sym_message_name] = sym_message_name,
  [sym_extend] = sym_extend,
  [sym_group] = sym_group,
  [sym_field] = sym_field,
  [sym_field_options] = sym_field_options,
  [sym_field_option] = sym_field_option,
  [sym_oneof] = sym_oneof,
  [sym_oneof_field] = sym_oneof_field,
  [sym_map_field] = sym_map_field,
  [sym_key_type] = sym_key_type,
  [sym_type] = sym_type,
  [sym_reserved] = sym_reserved,
  [sym_extensions] = sym_extensions,
  [sym_ranges] = sym_ranges,
  [sym_range] = sym_range,
  [sym_reserved_field_names] = sym_reserved_field_names,
  [sym_message_or_enum_type] = sym_message_or_enum_type,
  [sym_field_number] = sym_field_number,
  [sym_service] = sym_service,
  [sym_service_name] = sym_service_name,
  [sym_rpc] = sym_rpc,
  [sym_rpc_name] = sym_rpc_name,
  [sym_constant] = sym_constant,
  [sym_block_lit] = sym_block_lit,
  [sym_full_ident] = sym_full_ident,
  [sym_bool] = sym_bool,
  [sym_int_lit] = sym_int_lit,
  [sym_string] = sym_string,
  [aux_sym_source_file_repeat1] = aux_sym_source_file_repeat1,
  [aux_sym__option_name_repeat1] = aux_sym__option_name_repeat1,
  [aux_sym_enum_body_repeat1] = aux_sym_enum_body_repeat1,
  [aux_sym_enum_field_repeat1] = aux_sym_enum_field_repeat1,
  [aux_sym_message_body_repeat1] = aux_sym_message_body_repeat1,
  [aux_sym_field_options_repeat1] = aux_sym_field_options_repeat1,
  [aux_sym_oneof_repeat1] = aux_sym_oneof_repeat1,
  [aux_sym_ranges_repeat1] = aux_sym_ranges_repeat1,
  [aux_sym_reserved_field_names_repeat1] = aux_sym_reserved_field_names_repeat1,
  [aux_sym_message_or_enum_type_repeat1] = aux_sym_message_or_enum_type_repeat1,
  [aux_sym_service_repeat1] = aux_sym_service_repeat1,
  [aux_sym_rpc_repeat1] = aux_sym_rpc_repeat1,
  [aux_sym_block_lit_repeat1] = aux_sym_block_lit_repeat1,
  [aux_sym_block_lit_repeat2] = aux_sym_block_lit_repeat2,
  [aux_sym_string_repeat1] = aux_sym_string_repeat1,
  [aux_sym_string_repeat2] = aux_sym_string_repeat2,
  [aux_sym_string_repeat3] = aux_sym_string_repeat3,
};

static const TSSymbolMetadata ts_symbol_metadata[] = {
  [ts_builtin_sym_end] = {
    .visible = false,
    .named = true,
  },
  [anon_sym_SEMI] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_edition] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_EQ] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_syntax] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_DQUOTEproto3_DQUOTE] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_DQUOTEproto2_DQUOTE] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_import] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_weak] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_public] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_option] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_package] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_LPAREN] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_RPAREN] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_DOT] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_export] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_local] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_enum] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_LBRACE] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_RBRACE] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_DASH] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_LBRACK] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_COMMA] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_RBRACK] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_message] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_extend] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_optional] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_required] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_repeated] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_group] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_oneof] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_map] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_LT] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_GT] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_int32] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_int64] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_uint32] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_uint64] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_sint32] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_sint64] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_fixed32] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_fixed64] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_sfixed32] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_sfixed64] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_bool] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_string] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_double] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_float] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_bytes] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_reserved] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_extensions] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_to] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_max] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_service] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_rpc] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_stream] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_returns] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_PLUS] = {
    .visible = true,
    .named = false,
  },
  [anon_sym_COLON] = {
    .visible = true,
    .named = false,
  },
  [sym_identifier] = {
    .visible = true,
    .named = true,
  },
  [sym_reserved_identifier] = {
    .visible = true,
    .named = true,
  },
  [sym_true] = {
    .visible = true,
    .named = true,
  },
  [sym_false] = {
    .visible = true,
    .named = true,
  },
  [sym_decimal_lit] = {
    .visible = true,
    .named = true,
  },
  [sym_octal_lit] = {
    .visible = true,
    .named = true,
  },
  [sym_hex_lit] = {
    .visible = true,
    .named = true,
  },
  [sym_float_lit] = {
    .visible = true,
    .named = true,
  },
  [anon_sym_DQUOTE] = {
    .visible = true,
    .named = false,
  },
  [aux_sym_string_token1] = {
    .visible = false,
    .named = false,
  },
  [anon_sym_SQUOTE] = {
    .visible = true,
    .named = false,
  },
  [aux_sym_string_token2] = {
    .visible = false,
    .named = false,
  },
  [sym_escape_sequence] = {
    .visible = true,
    .named = true,
  },
  [sym_comment] = {
    .visible = true,
    .named = true,
  },
  [sym_source_file] = {
    .visible = true,
    .named = true,
  },
  [sym_empty_statement] = {
    .visible = true,
    .named = true,
  },
  [sym_edition] = {
    .visible = true,
    .named = true,
  },
  [sym_syntax] = {
    .visible = true,
    .named = true,
  },
  [sym_import] = {
    .visible = true,
    .named = true,
  },
  [sym_package] = {
    .visible = true,
    .named = true,
  },
  [sym_option] = {
    .visible = true,
    .named = true,
  },
  [sym__option_name] = {
    .visible = false,
    .named = true,
  },
  [sym_enum] = {
    .visible = true,
    .named = true,
  },
  [sym_enum_name] = {
    .visible = true,
    .named = true,
  },
  [sym_enum_body] = {
    .visible = true,
    .named = true,
  },
  [sym_enum_field] = {
    .visible = true,
    .named = true,
  },
  [sym_enum_value_option] = {
    .visible = true,
    .named = true,
  },
  [sym_message] = {
    .visible = true,
    .named = true,
  },
  [sym_message_body] = {
    .visible = true,
    .named = true,
  },
  [sym_message_name] = {
    .visible = true,
    .named = true,
  },
  [sym_extend] = {
    .visible = true,
    .named = true,
  },
  [sym_group] = {
    .visible = true,
    .named = true,
  },
  [sym_field] = {
    .visible = true,
    .named = true,
  },
  [sym_field_options] = {
    .visible = true,
    .named = true,
  },
  [sym_field_option] = {
    .visible = true,
    .named = true,
  },
  [sym_oneof] = {
    .visible = true,
    .named = true,
  },
  [sym_oneof_field] = {
    .visible = true,
    .named = true,
  },
  [sym_map_field] = {
    .visible = true,
    .named = true,
  },
  [sym_key_type] = {
    .visible = true,
    .named = true,
  },
  [sym_type] = {
    .visible = true,
    .named = true,
  },
  [sym_reserved] = {
    .visible = true,
    .named = true,
  },
  [sym_extensions] = {
    .visible = true,
    .named = true,
  },
  [sym_ranges] = {
    .visible = true,
    .named = true,
  },
  [sym_range] = {
    .visible = true,
    .named = true,
  },
  [sym_reserved_field_names] = {
    .visible = true,
    .named = true,
  },
  [sym_message_or_enum_type] = {
    .visible = true,
    .named = true,
  },
  [sym_field_number] = {
    .visible = true,
    .named = true,
  },
  [sym_service] = {
    .visible = true,
    .named = true,
  },
  [sym_service_name] = {
    .visible = true,
    .named = true,
  },
  [sym_rpc] = {
    .visible = true,
    .named = true,
  },
  [sym_rpc_name] = {
    .visible = true,
    .named = true,
  },
  [sym_constant] = {
    .visible = true,
    .named = true,
  },
  [sym_block_lit] = {
    .visible = true,
    .named = true,
  },
  [sym_full_ident] = {
    .visible = true,
    .named = true,
  },
  [sym_bool] = {
    .visible = true,
    .named = true,
  },
  [sym_int_lit] = {
    .visible = true,
    .named = true,
  },
  [sym_string] = {
    .visible = true,
    .named = true,
  },
  [aux_sym_source_file_repeat1] = {
    .visible = false,
    .named = false,
  },
  [aux_sym__option_name_repeat1] = {
    .visible = false,
    .named = false,
  },
  [aux_sym_enum_body_repeat1] = {
    .visible = false,
    .named = false,
  },
  [aux_sym_enum_field_repeat1] = {
    .visible = false,
    .named = false,
  },
  [aux_sym_message_body_repeat1] = {
    .visible = false,
    .named = false,
  },
  [aux_sym_field_options_repeat1] = {
    .visible = false,
    .named = false,
  },
  [aux_sym_oneof_repeat1] = {
    .visible = false,
    .named = false,
  },
  [aux_sym_ranges_repeat1] = {
    .visible = false,
    .named = false,
  },
  [aux_sym_reserved_field_names_repeat1] = {
    .visible = false,
    .named = false,
  },
  [aux_sym_message_or_enum_type_repeat1] = {
    .visible = false,
    .named = false,
  },
  [aux_sym_service_repeat1] = {
    .visible = false,
    .named = false,
  },
  [aux_sym_rpc_repeat1] = {
    .visible = false,
    .named = false,
  },
  [aux_sym_block_lit_repeat1] = {
    .visible = false,
    .named = false,
  },
  [aux_sym_block_lit_repeat2] = {
    .visible = false,
    .named = false,
  },
  [aux_sym_string_repeat1] = {
    .visible = false,
    .named = false,
  },
  [aux_sym_string_repeat2] = {
    .visible = false,
    .named = false,
  },
  [aux_sym_string_repeat3] = {
    .visible = false,
    .named = false,
  },
};

enum ts_field_identifiers {
  field_path = 1,
  field_year = 2,
};

static const char * const ts_field_names[] = {
  [0] = NULL,
  [field_path] = "path",
  [field_year] = "year",
};

static const TSFieldMapSlice ts_field_map_slices[PRODUCTION_ID_COUNT] = {
  [1] = {.index = 0, .length = 1},
  [2] = {.index = 1, .length = 1},
  [3] = {.index = 2, .length = 1},
};

static const TSFieldMapEntry ts_field_map_entries[] = {
  [0] =
    {field_path, 1},
  [1] =
    {field_year, 2},
  [2] =
    {field_path, 2},
};

static const TSSymbol ts_alias_sequences[PRODUCTION_ID_COUNT][MAX_ALIAS_SEQUENCE_LENGTH] = {
  [0] = {0},
};

static const uint16_t ts_non_terminal_alias_map[] = {
  0,
};

static const TSStateId ts_primary_state_ids[STATE_COUNT] = {
  [0] = 0,
  [1] = 1,
  [2] = 2,
  [3] = 3,
  [4] = 4,
  [5] = 3,
  [6] = 2,
  [7] = 7,
  [8] = 8,
  [9] = 9,
  [10] = 10,
  [11] = 11,
  [12] = 12,
  [13] = 13,
  [14] = 14,
  [15] = 15,
  [16] = 16,
  [17] = 17,
  [18] = 18,
  [19] = 19,
  [20] = 20,
  [21] = 21,
  [22] = 22,
  [23] = 23,
  [24] = 24,
  [25] = 25,
  [26] = 26,
  [27] = 27,
  [28] = 28,
  [29] = 29,
  [30] = 30,
  [31] = 31,
  [32] = 32,
  [33] = 33,
  [34] = 34,
  [35] = 35,
  [36] = 36,
  [37] = 37,
  [38] = 38,
  [39] = 39,
  [40] = 40,
  [41] = 41,
  [42] = 42,
  [43] = 43,
  [44] = 44,
  [45] = 45,
  [46] = 46,
  [47] = 47,
  [48] = 48,
  [49] = 49,
  [50] = 50,
  [51] = 51,
  [52] = 52,
  [53] = 53,
  [54] = 54,
  [55] = 30,
  [56] = 8,
  [57] = 57,
  [58] = 57,
  [59] = 59,
  [60] = 60,
  [61] = 61,
  [62] = 57,
  [63] = 57,
  [64] = 8,
  [65] = 65,
  [66] = 30,
  [67] = 67,
  [68] = 68,
  [69] = 28,
  [70] = 22,
  [71] = 71,
  [72] = 7,
  [73] = 73,
  [74] = 21,
  [75] = 23,
  [76] = 76,
  [77] = 77,
  [78] = 78,
  [79] = 24,
  [80] = 25,
  [81] = 26,
  [82] = 27,
  [83] = 83,
  [84] = 84,
  [85] = 85,
  [86] = 86,
  [87] = 87,
  [88] = 86,
  [89] = 89,
  [90] = 90,
  [91] = 87,
  [92] = 92,
  [93] = 93,
  [94] = 94,
  [95] = 95,
  [96] = 96,
  [97] = 97,
  [98] = 95,
  [99] = 99,
  [100] = 100,
  [101] = 101,
  [102] = 102,
  [103] = 103,
  [104] = 104,
  [105] = 105,
  [106] = 106,
  [107] = 107,
  [108] = 108,
  [109] = 39,
  [110] = 110,
  [111] = 111,
  [112] = 112,
  [113] = 113,
  [114] = 114,
  [115] = 115,
  [116] = 116,
  [117] = 117,
  [118] = 118,
  [119] = 119,
  [120] = 120,
  [121] = 121,
  [122] = 122,
  [123] = 123,
  [124] = 30,
  [125] = 125,
  [126] = 126,
  [127] = 127,
  [128] = 39,
  [129] = 129,
  [130] = 130,
  [131] = 131,
  [132] = 132,
  [133] = 8,
  [134] = 134,
  [135] = 135,
  [136] = 136,
  [137] = 137,
  [138] = 138,
  [139] = 139,
  [140] = 140,
  [141] = 141,
  [142] = 142,
  [143] = 143,
  [144] = 116,
  [145] = 145,
  [146] = 146,
  [147] = 147,
  [148] = 29,
  [149] = 149,
  [150] = 150,
  [151] = 151,
  [152] = 152,
  [153] = 153,
  [154] = 154,
  [155] = 155,
  [156] = 156,
  [157] = 157,
  [158] = 158,
  [159] = 159,
  [160] = 160,
  [161] = 161,
  [162] = 162,
  [163] = 163,
  [164] = 164,
  [165] = 165,
  [166] = 166,
  [167] = 167,
  [168] = 168,
  [169] = 169,
  [170] = 170,
  [171] = 171,
  [172] = 172,
  [173] = 173,
  [174] = 174,
  [175] = 175,
  [176] = 176,
  [177] = 177,
  [178] = 178,
  [179] = 179,
  [180] = 180,
  [181] = 181,
  [182] = 182,
  [183] = 183,
  [184] = 184,
  [185] = 185,
  [186] = 186,
  [187] = 187,
  [188] = 188,
  [189] = 189,
  [190] = 190,
  [191] = 191,
  [192] = 192,
  [193] = 193,
  [194] = 194,
  [195] = 195,
  [196] = 196,
  [197] = 197,
  [198] = 198,
  [199] = 199,
  [200] = 200,
  [201] = 201,
  [202] = 202,
  [203] = 203,
  [204] = 204,
  [205] = 188,
  [206] = 206,
  [207] = 207,
  [208] = 208,
  [209] = 209,
  [210] = 210,
  [211] = 211,
  [212] = 212,
  [213] = 213,
  [214] = 214,
  [215] = 188,
  [216] = 188,
  [217] = 217,
  [218] = 218,
  [219] = 219,
  [220] = 220,
  [221] = 221,
  [222] = 222,
  [223] = 223,
  [224] = 224,
  [225] = 225,
  [226] = 226,
  [227] = 227,
  [228] = 228,
  [229] = 229,
  [230] = 230,
  [231] = 231,
  [232] = 232,
  [233] = 233,
  [234] = 234,
  [235] = 235,
  [236] = 236,
  [237] = 237,
  [238] = 238,
  [239] = 239,
  [240] = 240,
  [241] = 241,
  [242] = 242,
  [243] = 243,
  [244] = 244,
  [245] = 245,
  [246] = 246,
  [247] = 247,
  [248] = 248,
  [249] = 249,
  [250] = 250,
  [251] = 251,
  [252] = 252,
  [253] = 253,
  [254] = 254,
  [255] = 255,
  [256] = 256,
  [257] = 247,
  [258] = 258,
  [259] = 259,
  [260] = 243,
  [261] = 244,
  [262] = 258,
  [263] = 221,
  [264] = 228,
  [265] = 255,
  [266] = 227,
  [267] = 248,
  [268] = 259,
  [269] = 269,
  [270] = 254,
  [271] = 271,
  [272] = 272,
  [273] = 273,
  [274] = 274,
  [275] = 275,
  [276] = 276,
  [277] = 277,
  [278] = 278,
  [279] = 279,
  [280] = 280,
  [281] = 281,
  [282] = 282,
  [283] = 283,
  [284] = 284,
  [285] = 285,
  [286] = 286,
  [287] = 287,
  [288] = 288,
  [289] = 289,
  [290] = 290,
  [291] = 291,
  [292] = 292,
  [293] = 293,
  [294] = 294,
  [295] = 295,
  [296] = 296,
  [297] = 297,
  [298] = 298,
  [299] = 299,
  [300] = 300,
  [301] = 301,
  [302] = 302,
  [303] = 303,
  [304] = 304,
  [305] = 305,
  [306] = 306,
  [307] = 307,
  [308] = 308,
  [309] = 309,
  [310] = 310,
  [311] = 311,
  [312] = 312,
  [313] = 313,
  [314] = 314,
  [315] = 315,
  [316] = 316,
  [317] = 317,
  [318] = 318,
  [319] = 319,
  [320] = 320,
  [321] = 321,
  [322] = 308,
  [323] = 323,
  [324] = 324,
  [325] = 303,
  [326] = 308,
  [327] = 308,
  [328] = 328,
  [329] = 329,
  [330] = 330,
  [331] = 331,
  [332] = 332,
  [333] = 333,
  [334] = 334,
  [335] = 335,
  [336] = 336,
  [337] = 337,
  [338] = 338,
  [339] = 338,
  [340] = 338,
  [341] = 341,
  [342] = 342,
  [343] = 343,
  [344] = 338,
};

static bool ts_lex(TSLexer *lexer, TSStateId state) {
  START_LEXER();
  eof = lexer->eof(lexer);
  switch (state) {
    case 0:
      if (eof) ADVANCE(212);
      ADVANCE_MAP(
        '"', 450,
        '\'', 457,
        '(', 227,
        ')', 228,
        '+', 302,
        ',', 241,
        '-', 239,
        '.', 230,
        '/', 11,
        '0', 442,
        ':', 303,
        ';', 213,
        '<', 259,
        '=', 215,
        '>', 260,
        '[', 240,
        '\\', 38,
        ']', 242,
        'b', 138,
        'd', 132,
        'e', 64,
        'f', 39,
        'g', 165,
        'i', 115,
        'l', 133,
        'm', 40,
        'n', 41,
        'o', 123,
        'p', 44,
        'r', 68,
        's', 76,
        't', 134,
        'u', 105,
        'w', 78,
        '{', 237,
        '}', 238,
      );
      if (('\t' <= lookahead && lookahead <= '\r') ||
          lookahead == ' ') SKIP(210);
      if (('1' <= lookahead && lookahead <= '9')) ADVANCE(440);
      END_STATE();
    case 1:
      ADVANCE_MAP(
        '"', 450,
        '\'', 457,
        '(', 227,
        ')', 228,
        ',', 241,
        '.', 229,
        '/', 11,
        ';', 213,
        '=', 215,
        '>', 260,
        '[', 240,
        ']', 242,
        '{', 237,
        '}', 238,
      );
      if (('\t' <= lookahead && lookahead <= '\r') ||
          lookahead == ' ') SKIP(1);
      if (('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 2:
      ADVANCE_MAP(
        '"', 450,
        '\'', 457,
        '+', 302,
        '-', 239,
        '.', 197,
        '/', 11,
        '0', 442,
        ':', 303,
        '[', 240,
        ']', 242,
        'f', 324,
        'i', 380,
        'n', 325,
        't', 405,
        '{', 237,
      );
      if (('\t' <= lookahead && lookahead <= '\r') ||
          lookahead == ' ') SKIP(2);
      if (('1' <= lookahead && lookahead <= '9')) ADVANCE(440);
      if (('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 3:
      if (lookahead == '"') ADVANCE(450);
      if (lookahead == '/') ADVANCE(452);
      if (lookahead == '\\') ADVANCE(38);
      if (('\t' <= lookahead && lookahead <= '\r') ||
          lookahead == ' ') ADVANCE(455);
      if (lookahead != 0) ADVANCE(456);
      END_STATE();
    case 4:
      if (lookahead == '"') ADVANCE(218);
      END_STATE();
    case 5:
      if (lookahead == '"') ADVANCE(217);
      END_STATE();
    case 6:
      if (lookahead == '"') ADVANCE(208);
      if (lookahead == '\'') ADVANCE(209);
      if (lookahead == '/') ADVANCE(11);
      if (lookahead == '0') ADVANCE(444);
      if (('\t' <= lookahead && lookahead <= '\r') ||
          lookahead == ' ') SKIP(6);
      if (('1' <= lookahead && lookahead <= '9')) ADVANCE(441);
      if (('A' <= lookahead && lookahead <= 'Z') ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(435);
      END_STATE();
    case 7:
      if (lookahead == '"') ADVANCE(434);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(7);
      END_STATE();
    case 8:
      ADVANCE_MAP(
        '"', 153,
        '.', 229,
        '/', 11,
        ';', 213,
        'b', 390,
        'd', 385,
        'e', 379,
        'f', 358,
        'g', 408,
        'i', 378,
        'l', 386,
        'm', 319,
        'o', 377,
        'r', 335,
        's', 355,
        'u', 364,
        '}', 238,
      );
      if (('\t' <= lookahead && lookahead <= '\r') ||
          lookahead == ' ') SKIP(8);
      if (('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 9:
      if (lookahead == '\'') ADVANCE(457);
      if (lookahead == '/') ADVANCE(459);
      if (lookahead == '\\') ADVANCE(38);
      if (('\t' <= lookahead && lookahead <= '\r') ||
          lookahead == ' ') ADVANCE(462);
      if (lookahead != 0) ADVANCE(463);
      END_STATE();
    case 10:
      if (lookahead == '\'') ADVANCE(434);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(10);
      END_STATE();
    case 11:
      if (lookahead == '*') ADVANCE(13);
      if (lookahead == '/') ADVANCE(468);
      END_STATE();
    case 12:
      if (lookahead == '*') ADVANCE(12);
      if (lookahead == '/') ADVANCE(467);
      if (lookahead != 0) ADVANCE(13);
      END_STATE();
    case 13:
      if (lookahead == '*') ADVANCE(12);
      if (lookahead != 0) ADVANCE(13);
      END_STATE();
    case 14:
      if (lookahead == '.') ADVANCE(448);
      if (lookahead == 'E' ||
          lookahead == 'e') ADVANCE(196);
      if (('0' <= lookahead && lookahead <= '9')) ADVANCE(14);
      END_STATE();
    case 15:
      ADVANCE_MAP(
        '.', 229,
        '/', 11,
        ';', 213,
        '[', 240,
        'b', 390,
        'd', 385,
        'f', 358,
        'i', 378,
        'o', 401,
        's', 355,
        'u', 364,
        '{', 237,
        '}', 238,
      );
      if (('\t' <= lookahead && lookahead <= '\r') ||
          lookahead == ' ') SKIP(15);
      if (('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 16:
      ADVANCE_MAP(
        '.', 229,
        '/', 11,
        'b', 390,
        'd', 385,
        'f', 358,
        'g', 408,
        'i', 378,
        'r', 346,
        's', 355,
        'u', 364,
      );
      if (('\t' <= lookahead && lookahead <= '\r') ||
          lookahead == ' ') SKIP(16);
      if (('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 17:
      ADVANCE_MAP(
        '.', 229,
        '/', 11,
        'b', 390,
        'd', 385,
        'f', 358,
        'g', 408,
        'i', 378,
        's', 355,
        'u', 364,
      );
      if (('\t' <= lookahead && lookahead <= '\r') ||
          lookahead == ' ') SKIP(17);
      if (('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 18:
      ADVANCE_MAP(
        '.', 229,
        '/', 11,
        'b', 390,
        'd', 385,
        'f', 358,
        'i', 378,
        's', 355,
        'u', 364,
      );
      if (('\t' <= lookahead && lookahead <= '\r') ||
          lookahead == ' ') SKIP(18);
      if (('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 19:
      if (lookahead == '.') ADVANCE(229);
      if (lookahead == '/') ADVANCE(11);
      if (lookahead == 's') ADVANCE(422);
      if (('\t' <= lookahead && lookahead <= '\r') ||
          lookahead == ' ') SKIP(19);
      if (('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 20:
      if (lookahead == '.') ADVANCE(197);
      if (lookahead == '/') ADVANCE(11);
      if (lookahead == '0') ADVANCE(442);
      if (lookahead == 'i') ADVANCE(124);
      if (lookahead == 'n') ADVANCE(41);
      if (('\t' <= lookahead && lookahead <= '\r') ||
          lookahead == ' ') SKIP(20);
      if (('1' <= lookahead && lookahead <= '9')) ADVANCE(440);
      END_STATE();
    case 21:
      if (lookahead == '/') ADVANCE(11);
      if (lookahead == ';') ADVANCE(213);
      if (lookahead == 'o') ADVANCE(401);
      if (lookahead == 'r') ADVANCE(351);
      if (lookahead == '}') ADVANCE(238);
      if (('\t' <= lookahead && lookahead <= '\r') ||
          lookahead == ' ') SKIP(21);
      if (('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 22:
      if (lookahead == '2') ADVANCE(261);
      END_STATE();
    case 23:
      if (lookahead == '2') ADVANCE(269);
      END_STATE();
    case 24:
      if (lookahead == '2') ADVANCE(265);
      END_STATE();
    case 25:
      if (lookahead == '2') ADVANCE(273);
      END_STATE();
    case 26:
      if (lookahead == '2') ADVANCE(277);
      END_STATE();
    case 27:
      if (lookahead == '2') ADVANCE(4);
      if (lookahead == '3') ADVANCE(5);
      END_STATE();
    case 28:
      if (lookahead == '3') ADVANCE(22);
      if (lookahead == '6') ADVANCE(33);
      END_STATE();
    case 29:
      if (lookahead == '3') ADVANCE(23);
      if (lookahead == '6') ADVANCE(34);
      END_STATE();
    case 30:
      if (lookahead == '3') ADVANCE(24);
      if (lookahead == '6') ADVANCE(35);
      END_STATE();
    case 31:
      if (lookahead == '3') ADVANCE(25);
      if (lookahead == '6') ADVANCE(36);
      END_STATE();
    case 32:
      if (lookahead == '3') ADVANCE(26);
      if (lookahead == '6') ADVANCE(37);
      END_STATE();
    case 33:
      if (lookahead == '4') ADVANCE(263);
      END_STATE();
    case 34:
      if (lookahead == '4') ADVANCE(271);
      END_STATE();
    case 35:
      if (lookahead == '4') ADVANCE(267);
      END_STATE();
    case 36:
      if (lookahead == '4') ADVANCE(275);
      END_STATE();
    case 37:
      if (lookahead == '4') ADVANCE(279);
      END_STATE();
    case 38:
      if (lookahead == 'U') ADVANCE(207);
      if (lookahead == 'u') ADVANCE(203);
      if (lookahead == 'x') ADVANCE(201);
      if (('0' <= lookahead && lookahead <= '9')) ADVANCE(466);
      if (lookahead != 0) ADVANCE(464);
      END_STATE();
    case 39:
      if (lookahead == 'a') ADVANCE(111);
      if (lookahead == 'i') ADVANCE(194);
      if (lookahead == 'l') ADVANCE(139);
      END_STATE();
    case 40:
      if (lookahead == 'a') ADVANCE(148);
      if (lookahead == 'e') ADVANCE(169);
      END_STATE();
    case 41:
      if (lookahead == 'a') ADVANCE(118);
      END_STATE();
    case 42:
      if (lookahead == 'a') ADVANCE(94);
      END_STATE();
    case 43:
      if (lookahead == 'a') ADVANCE(193);
      END_STATE();
    case 44:
      if (lookahead == 'a') ADVANCE(54);
      if (lookahead == 'u') ADVANCE(52);
      END_STATE();
    case 45:
      if (lookahead == 'a') ADVANCE(117);
      END_STATE();
    case 46:
      if (lookahead == 'a') ADVANCE(106);
      END_STATE();
    case 47:
      if (lookahead == 'a') ADVANCE(192);
      if (lookahead == 'e') ADVANCE(169);
      END_STATE();
    case 48:
      if (lookahead == 'a') ADVANCE(172);
      END_STATE();
    case 49:
      if (lookahead == 'a') ADVANCE(109);
      END_STATE();
    case 50:
      if (lookahead == 'a') ADVANCE(179);
      END_STATE();
    case 51:
      if (lookahead == 'a') ADVANCE(95);
      END_STATE();
    case 52:
      if (lookahead == 'b') ADVANCE(112);
      END_STATE();
    case 53:
      if (lookahead == 'b') ADVANCE(113);
      END_STATE();
    case 54:
      if (lookahead == 'c') ADVANCE(107);
      END_STATE();
    case 55:
      if (lookahead == 'c') ADVANCE(298);
      END_STATE();
    case 56:
      if (lookahead == 'c') ADVANCE(221);
      END_STATE();
    case 57:
      if (lookahead == 'c') ADVANCE(49);
      END_STATE();
    case 58:
      if (lookahead == 'c') ADVANCE(75);
      END_STATE();
    case 59:
      if (lookahead == 'd') ADVANCE(245);
      END_STATE();
    case 60:
      if (lookahead == 'd') ADVANCE(245);
      if (lookahead == 's') ADVANCE(101);
      END_STATE();
    case 61:
      if (lookahead == 'd') ADVANCE(251);
      END_STATE();
    case 62:
      if (lookahead == 'd') ADVANCE(249);
      END_STATE();
    case 63:
      if (lookahead == 'd') ADVANCE(291);
      END_STATE();
    case 64:
      if (lookahead == 'd') ADVANCE(103);
      if (lookahead == 'n') ADVANCE(184);
      if (lookahead == 'x') ADVANCE(151);
      END_STATE();
    case 65:
      if (lookahead == 'd') ADVANCE(103);
      if (lookahead == 'n') ADVANCE(184);
      if (lookahead == 'x') ADVANCE(152);
      END_STATE();
    case 66:
      if (lookahead == 'd') ADVANCE(31);
      END_STATE();
    case 67:
      if (lookahead == 'd') ADVANCE(32);
      END_STATE();
    case 68:
      if (lookahead == 'e') ADVANCE(154);
      if (lookahead == 'p') ADVANCE(55);
      END_STATE();
    case 69:
      if (lookahead == 'e') ADVANCE(66);
      END_STATE();
    case 70:
      if (lookahead == 'e') ADVANCE(436);
      END_STATE();
    case 71:
      if (lookahead == 'e') ADVANCE(438);
      END_STATE();
    case 72:
      if (lookahead == 'e') ADVANCE(285);
      END_STATE();
    case 73:
      if (lookahead == 'e') ADVANCE(243);
      END_STATE();
    case 74:
      if (lookahead == 'e') ADVANCE(226);
      END_STATE();
    case 75:
      if (lookahead == 'e') ADVANCE(297);
      END_STATE();
    case 76:
      if (lookahead == 'e') ADVANCE(157);
      if (lookahead == 'f') ADVANCE(104);
      if (lookahead == 'i') ADVANCE(126);
      if (lookahead == 't') ADVANCE(158);
      if (lookahead == 'y') ADVANCE(127);
      END_STATE();
    case 77:
      if (lookahead == 'e') ADVANCE(157);
      if (lookahead == 'y') ADVANCE(127);
      END_STATE();
    case 78:
      if (lookahead == 'e') ADVANCE(46);
      END_STATE();
    case 79:
      if (lookahead == 'e') ADVANCE(61);
      END_STATE();
    case 80:
      if (lookahead == 'e') ADVANCE(119);
      END_STATE();
    case 81:
      if (lookahead == 'e') ADVANCE(62);
      END_STATE();
    case 82:
      if (lookahead == 'e') ADVANCE(166);
      END_STATE();
    case 83:
      if (lookahead == 'e') ADVANCE(63);
      END_STATE();
    case 84:
      if (lookahead == 'e') ADVANCE(159);
      END_STATE();
    case 85:
      if (lookahead == 'e') ADVANCE(135);
      END_STATE();
    case 86:
      if (lookahead == 'e') ADVANCE(50);
      END_STATE();
    case 87:
      if (lookahead == 'e') ADVANCE(45);
      if (lookahead == 'i') ADVANCE(125);
      END_STATE();
    case 88:
      if (lookahead == 'e') ADVANCE(129);
      END_STATE();
    case 89:
      if (lookahead == 'e') ADVANCE(67);
      END_STATE();
    case 90:
      if (lookahead == 'f') ADVANCE(447);
      END_STATE();
    case 91:
      if (lookahead == 'f') ADVANCE(447);
      if (lookahead == 't') ADVANCE(28);
      END_STATE();
    case 92:
      if (lookahead == 'f') ADVANCE(255);
      END_STATE();
    case 93:
      if (lookahead == 'g') ADVANCE(283);
      END_STATE();
    case 94:
      if (lookahead == 'g') ADVANCE(73);
      END_STATE();
    case 95:
      if (lookahead == 'g') ADVANCE(74);
      END_STATE();
    case 96:
      if (lookahead == 'i') ADVANCE(56);
      END_STATE();
    case 97:
      if (lookahead == 'i') ADVANCE(58);
      END_STATE();
    case 98:
      if (lookahead == 'i') ADVANCE(142);
      END_STATE();
    case 99:
      if (lookahead == 'i') ADVANCE(164);
      END_STATE();
    case 100:
      if (lookahead == 'i') ADVANCE(143);
      END_STATE();
    case 101:
      if (lookahead == 'i') ADVANCE(145);
      END_STATE();
    case 102:
      if (lookahead == 'i') ADVANCE(146);
      END_STATE();
    case 103:
      if (lookahead == 'i') ADVANCE(181);
      END_STATE();
    case 104:
      if (lookahead == 'i') ADVANCE(195);
      END_STATE();
    case 105:
      if (lookahead == 'i') ADVANCE(131);
      END_STATE();
    case 106:
      if (lookahead == 'k') ADVANCE(220);
      END_STATE();
    case 107:
      if (lookahead == 'k') ADVANCE(51);
      END_STATE();
    case 108:
      if (lookahead == 'l') ADVANCE(281);
      END_STATE();
    case 109:
      if (lookahead == 'l') ADVANCE(233);
      END_STATE();
    case 110:
      if (lookahead == 'l') ADVANCE(247);
      END_STATE();
    case 111:
      if (lookahead == 'l') ADVANCE(171);
      END_STATE();
    case 112:
      if (lookahead == 'l') ADVANCE(96);
      END_STATE();
    case 113:
      if (lookahead == 'l') ADVANCE(72);
      END_STATE();
    case 114:
      if (lookahead == 'm') ADVANCE(155);
      END_STATE();
    case 115:
      if (lookahead == 'm') ADVANCE(155);
      if (lookahead == 'n') ADVANCE(91);
      END_STATE();
    case 116:
      if (lookahead == 'm') ADVANCE(235);
      END_STATE();
    case 117:
      if (lookahead == 'm') ADVANCE(299);
      END_STATE();
    case 118:
      if (lookahead == 'n') ADVANCE(447);
      END_STATE();
    case 119:
      if (lookahead == 'n') ADVANCE(60);
      END_STATE();
    case 120:
      if (lookahead == 'n') ADVANCE(224);
      END_STATE();
    case 121:
      if (lookahead == 'n') ADVANCE(214);
      END_STATE();
    case 122:
      if (lookahead == 'n') ADVANCE(222);
      END_STATE();
    case 123:
      if (lookahead == 'n') ADVANCE(85);
      if (lookahead == 'p') ADVANCE(176);
      END_STATE();
    case 124:
      if (lookahead == 'n') ADVANCE(90);
      END_STATE();
    case 125:
      if (lookahead == 'n') ADVANCE(93);
      END_STATE();
    case 126:
      if (lookahead == 'n') ADVANCE(180);
      END_STATE();
    case 127:
      if (lookahead == 'n') ADVANCE(177);
      END_STATE();
    case 128:
      if (lookahead == 'n') ADVANCE(167);
      END_STATE();
    case 129:
      if (lookahead == 'n') ADVANCE(59);
      END_STATE();
    case 130:
      if (lookahead == 'n') ADVANCE(168);
      END_STATE();
    case 131:
      if (lookahead == 'n') ADVANCE(182);
      END_STATE();
    case 132:
      if (lookahead == 'o') ADVANCE(189);
      END_STATE();
    case 133:
      if (lookahead == 'o') ADVANCE(57);
      END_STATE();
    case 134:
      if (lookahead == 'o') ADVANCE(295);
      if (lookahead == 'r') ADVANCE(188);
      END_STATE();
    case 135:
      if (lookahead == 'o') ADVANCE(92);
      END_STATE();
    case 136:
      if (lookahead == 'o') ADVANCE(27);
      END_STATE();
    case 137:
      if (lookahead == 'o') ADVANCE(108);
      END_STATE();
    case 138:
      if (lookahead == 'o') ADVANCE(137);
      if (lookahead == 'y') ADVANCE(175);
      END_STATE();
    case 139:
      if (lookahead == 'o') ADVANCE(48);
      END_STATE();
    case 140:
      if (lookahead == 'o') ADVANCE(160);
      END_STATE();
    case 141:
      if (lookahead == 'o') ADVANCE(185);
      END_STATE();
    case 142:
      if (lookahead == 'o') ADVANCE(120);
      END_STATE();
    case 143:
      if (lookahead == 'o') ADVANCE(121);
      END_STATE();
    case 144:
      if (lookahead == 'o') ADVANCE(178);
      END_STATE();
    case 145:
      if (lookahead == 'o') ADVANCE(130);
      END_STATE();
    case 146:
      if (lookahead == 'o') ADVANCE(122);
      END_STATE();
    case 147:
      if (lookahead == 'o') ADVANCE(162);
      END_STATE();
    case 148:
      if (lookahead == 'p') ADVANCE(257);
      if (lookahead == 'x') ADVANCE(296);
      END_STATE();
    case 149:
      if (lookahead == 'p') ADVANCE(253);
      END_STATE();
    case 150:
      if (lookahead == 'p') ADVANCE(55);
      END_STATE();
    case 151:
      if (lookahead == 'p') ADVANCE(140);
      if (lookahead == 't') ADVANCE(80);
      END_STATE();
    case 152:
      if (lookahead == 'p') ADVANCE(140);
      if (lookahead == 't') ADVANCE(88);
      END_STATE();
    case 153:
      if (lookahead == 'p') ADVANCE(163);
      END_STATE();
    case 154:
      if (lookahead == 'p') ADVANCE(86);
      if (lookahead == 'q') ADVANCE(187);
      if (lookahead == 's') ADVANCE(84);
      if (lookahead == 't') ADVANCE(186);
      END_STATE();
    case 155:
      if (lookahead == 'p') ADVANCE(147);
      END_STATE();
    case 156:
      if (lookahead == 'p') ADVANCE(183);
      END_STATE();
    case 157:
      if (lookahead == 'r') ADVANCE(190);
      END_STATE();
    case 158:
      if (lookahead == 'r') ADVANCE(87);
      END_STATE();
    case 159:
      if (lookahead == 'r') ADVANCE(191);
      END_STATE();
    case 160:
      if (lookahead == 'r') ADVANCE(173);
      END_STATE();
    case 161:
      if (lookahead == 'r') ADVANCE(128);
      END_STATE();
    case 162:
      if (lookahead == 'r') ADVANCE(174);
      END_STATE();
    case 163:
      if (lookahead == 'r') ADVANCE(144);
      END_STATE();
    case 164:
      if (lookahead == 'r') ADVANCE(81);
      END_STATE();
    case 165:
      if (lookahead == 'r') ADVANCE(141);
      END_STATE();
    case 166:
      if (lookahead == 's') ADVANCE(289);
      END_STATE();
    case 167:
      if (lookahead == 's') ADVANCE(301);
      END_STATE();
    case 168:
      if (lookahead == 's') ADVANCE(293);
      END_STATE();
    case 169:
      if (lookahead == 's') ADVANCE(170);
      END_STATE();
    case 170:
      if (lookahead == 's') ADVANCE(42);
      END_STATE();
    case 171:
      if (lookahead == 's') ADVANCE(71);
      END_STATE();
    case 172:
      if (lookahead == 't') ADVANCE(287);
      END_STATE();
    case 173:
      if (lookahead == 't') ADVANCE(231);
      END_STATE();
    case 174:
      if (lookahead == 't') ADVANCE(219);
      END_STATE();
    case 175:
      if (lookahead == 't') ADVANCE(82);
      END_STATE();
    case 176:
      if (lookahead == 't') ADVANCE(98);
      END_STATE();
    case 177:
      if (lookahead == 't') ADVANCE(43);
      END_STATE();
    case 178:
      if (lookahead == 't') ADVANCE(136);
      END_STATE();
    case 179:
      if (lookahead == 't') ADVANCE(79);
      END_STATE();
    case 180:
      if (lookahead == 't') ADVANCE(29);
      END_STATE();
    case 181:
      if (lookahead == 't') ADVANCE(100);
      END_STATE();
    case 182:
      if (lookahead == 't') ADVANCE(30);
      END_STATE();
    case 183:
      if (lookahead == 't') ADVANCE(102);
      END_STATE();
    case 184:
      if (lookahead == 'u') ADVANCE(116);
      END_STATE();
    case 185:
      if (lookahead == 'u') ADVANCE(149);
      END_STATE();
    case 186:
      if (lookahead == 'u') ADVANCE(161);
      END_STATE();
    case 187:
      if (lookahead == 'u') ADVANCE(99);
      END_STATE();
    case 188:
      if (lookahead == 'u') ADVANCE(70);
      END_STATE();
    case 189:
      if (lookahead == 'u') ADVANCE(53);
      END_STATE();
    case 190:
      if (lookahead == 'v') ADVANCE(97);
      END_STATE();
    case 191:
      if (lookahead == 'v') ADVANCE(83);
      END_STATE();
    case 192:
      if (lookahead == 'x') ADVANCE(296);
      END_STATE();
    case 193:
      if (lookahead == 'x') ADVANCE(216);
      END_STATE();
    case 194:
      if (lookahead == 'x') ADVANCE(69);
      END_STATE();
    case 195:
      if (lookahead == 'x') ADVANCE(89);
      END_STATE();
    case 196:
      if (lookahead == '+' ||
          lookahead == '-') ADVANCE(198);
      if (('0' <= lookahead && lookahead <= '9')) ADVANCE(449);
      END_STATE();
    case 197:
      if (('0' <= lookahead && lookahead <= '9')) ADVANCE(448);
      END_STATE();
    case 198:
      if (('0' <= lookahead && lookahead <= '9')) ADVANCE(449);
      END_STATE();
    case 199:
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'F') ||
          ('a' <= lookahead && lookahead <= 'f')) ADVANCE(464);
      END_STATE();
    case 200:
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'F') ||
          ('a' <= lookahead && lookahead <= 'f')) ADVANCE(446);
      END_STATE();
    case 201:
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'F') ||
          ('a' <= lookahead && lookahead <= 'f')) ADVANCE(199);
      END_STATE();
    case 202:
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'F') ||
          ('a' <= lookahead && lookahead <= 'f')) ADVANCE(201);
      END_STATE();
    case 203:
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'F') ||
          ('a' <= lookahead && lookahead <= 'f')) ADVANCE(202);
      END_STATE();
    case 204:
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'F') ||
          ('a' <= lookahead && lookahead <= 'f')) ADVANCE(203);
      END_STATE();
    case 205:
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'F') ||
          ('a' <= lookahead && lookahead <= 'f')) ADVANCE(204);
      END_STATE();
    case 206:
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'F') ||
          ('a' <= lookahead && lookahead <= 'f')) ADVANCE(205);
      END_STATE();
    case 207:
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'F') ||
          ('a' <= lookahead && lookahead <= 'f')) ADVANCE(206);
      END_STATE();
    case 208:
      if (('A' <= lookahead && lookahead <= 'Z') ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(7);
      END_STATE();
    case 209:
      if (('A' <= lookahead && lookahead <= 'Z') ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(10);
      END_STATE();
    case 210:
      if (eof) ADVANCE(212);
      ADVANCE_MAP(
        '"', 450,
        '\'', 457,
        '(', 227,
        ')', 228,
        '+', 302,
        ',', 241,
        '-', 239,
        '.', 230,
        '/', 11,
        '0', 442,
        ':', 303,
        ';', 213,
        '<', 259,
        '=', 215,
        '>', 260,
        '[', 240,
        ']', 242,
        'b', 138,
        'd', 132,
        'e', 64,
        'f', 39,
        'g', 165,
        'i', 115,
        'l', 133,
        'm', 40,
        'n', 41,
        'o', 123,
        'p', 44,
        'r', 68,
        's', 76,
        't', 134,
        'u', 105,
        'w', 78,
        '{', 237,
        '}', 238,
      );
      if (('\t' <= lookahead && lookahead <= '\r') ||
          lookahead == ' ') SKIP(210);
      if (('1' <= lookahead && lookahead <= '9')) ADVANCE(440);
      END_STATE();
    case 211:
      if (eof) ADVANCE(212);
      ADVANCE_MAP(
        '"', 450,
        '\'', 457,
        '-', 239,
        '.', 229,
        '/', 11,
        '0', 444,
        ';', 213,
        '=', 215,
        'e', 65,
        'i', 114,
        'l', 133,
        'm', 47,
        'o', 156,
        'p', 44,
        'r', 150,
        's', 77,
        'w', 78,
        '}', 238,
      );
      if (('\t' <= lookahead && lookahead <= '\r') ||
          lookahead == ' ') SKIP(211);
      if (('1' <= lookahead && lookahead <= '9')) ADVANCE(441);
      END_STATE();
    case 212:
      ACCEPT_TOKEN(ts_builtin_sym_end);
      END_STATE();
    case 213:
      ACCEPT_TOKEN(anon_sym_SEMI);
      END_STATE();
    case 214:
      ACCEPT_TOKEN(anon_sym_edition);
      END_STATE();
    case 215:
      ACCEPT_TOKEN(anon_sym_EQ);
      END_STATE();
    case 216:
      ACCEPT_TOKEN(anon_sym_syntax);
      END_STATE();
    case 217:
      ACCEPT_TOKEN(anon_sym_DQUOTEproto3_DQUOTE);
      END_STATE();
    case 218:
      ACCEPT_TOKEN(anon_sym_DQUOTEproto2_DQUOTE);
      END_STATE();
    case 219:
      ACCEPT_TOKEN(anon_sym_import);
      END_STATE();
    case 220:
      ACCEPT_TOKEN(anon_sym_weak);
      END_STATE();
    case 221:
      ACCEPT_TOKEN(anon_sym_public);
      END_STATE();
    case 222:
      ACCEPT_TOKEN(anon_sym_option);
      END_STATE();
    case 223:
      ACCEPT_TOKEN(anon_sym_option);
      if (lookahead == 'a') ADVANCE(368);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('b' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 224:
      ACCEPT_TOKEN(anon_sym_option);
      if (lookahead == 'a') ADVANCE(110);
      END_STATE();
    case 225:
      ACCEPT_TOKEN(anon_sym_option);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 226:
      ACCEPT_TOKEN(anon_sym_package);
      END_STATE();
    case 227:
      ACCEPT_TOKEN(anon_sym_LPAREN);
      END_STATE();
    case 228:
      ACCEPT_TOKEN(anon_sym_RPAREN);
      END_STATE();
    case 229:
      ACCEPT_TOKEN(anon_sym_DOT);
      END_STATE();
    case 230:
      ACCEPT_TOKEN(anon_sym_DOT);
      if (('0' <= lookahead && lookahead <= '9')) ADVANCE(448);
      END_STATE();
    case 231:
      ACCEPT_TOKEN(anon_sym_export);
      END_STATE();
    case 232:
      ACCEPT_TOKEN(anon_sym_export);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 233:
      ACCEPT_TOKEN(anon_sym_local);
      END_STATE();
    case 234:
      ACCEPT_TOKEN(anon_sym_local);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 235:
      ACCEPT_TOKEN(anon_sym_enum);
      END_STATE();
    case 236:
      ACCEPT_TOKEN(anon_sym_enum);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 237:
      ACCEPT_TOKEN(anon_sym_LBRACE);
      END_STATE();
    case 238:
      ACCEPT_TOKEN(anon_sym_RBRACE);
      END_STATE();
    case 239:
      ACCEPT_TOKEN(anon_sym_DASH);
      END_STATE();
    case 240:
      ACCEPT_TOKEN(anon_sym_LBRACK);
      END_STATE();
    case 241:
      ACCEPT_TOKEN(anon_sym_COMMA);
      END_STATE();
    case 242:
      ACCEPT_TOKEN(anon_sym_RBRACK);
      END_STATE();
    case 243:
      ACCEPT_TOKEN(anon_sym_message);
      END_STATE();
    case 244:
      ACCEPT_TOKEN(anon_sym_message);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 245:
      ACCEPT_TOKEN(anon_sym_extend);
      END_STATE();
    case 246:
      ACCEPT_TOKEN(anon_sym_extend);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 247:
      ACCEPT_TOKEN(anon_sym_optional);
      END_STATE();
    case 248:
      ACCEPT_TOKEN(anon_sym_optional);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 249:
      ACCEPT_TOKEN(anon_sym_required);
      END_STATE();
    case 250:
      ACCEPT_TOKEN(anon_sym_required);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 251:
      ACCEPT_TOKEN(anon_sym_repeated);
      END_STATE();
    case 252:
      ACCEPT_TOKEN(anon_sym_repeated);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 253:
      ACCEPT_TOKEN(anon_sym_group);
      END_STATE();
    case 254:
      ACCEPT_TOKEN(anon_sym_group);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 255:
      ACCEPT_TOKEN(anon_sym_oneof);
      END_STATE();
    case 256:
      ACCEPT_TOKEN(anon_sym_oneof);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 257:
      ACCEPT_TOKEN(anon_sym_map);
      END_STATE();
    case 258:
      ACCEPT_TOKEN(anon_sym_map);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 259:
      ACCEPT_TOKEN(anon_sym_LT);
      END_STATE();
    case 260:
      ACCEPT_TOKEN(anon_sym_GT);
      END_STATE();
    case 261:
      ACCEPT_TOKEN(anon_sym_int32);
      END_STATE();
    case 262:
      ACCEPT_TOKEN(anon_sym_int32);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 263:
      ACCEPT_TOKEN(anon_sym_int64);
      END_STATE();
    case 264:
      ACCEPT_TOKEN(anon_sym_int64);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 265:
      ACCEPT_TOKEN(anon_sym_uint32);
      END_STATE();
    case 266:
      ACCEPT_TOKEN(anon_sym_uint32);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 267:
      ACCEPT_TOKEN(anon_sym_uint64);
      END_STATE();
    case 268:
      ACCEPT_TOKEN(anon_sym_uint64);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 269:
      ACCEPT_TOKEN(anon_sym_sint32);
      END_STATE();
    case 270:
      ACCEPT_TOKEN(anon_sym_sint32);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 271:
      ACCEPT_TOKEN(anon_sym_sint64);
      END_STATE();
    case 272:
      ACCEPT_TOKEN(anon_sym_sint64);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 273:
      ACCEPT_TOKEN(anon_sym_fixed32);
      END_STATE();
    case 274:
      ACCEPT_TOKEN(anon_sym_fixed32);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 275:
      ACCEPT_TOKEN(anon_sym_fixed64);
      END_STATE();
    case 276:
      ACCEPT_TOKEN(anon_sym_fixed64);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 277:
      ACCEPT_TOKEN(anon_sym_sfixed32);
      END_STATE();
    case 278:
      ACCEPT_TOKEN(anon_sym_sfixed32);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 279:
      ACCEPT_TOKEN(anon_sym_sfixed64);
      END_STATE();
    case 280:
      ACCEPT_TOKEN(anon_sym_sfixed64);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 281:
      ACCEPT_TOKEN(anon_sym_bool);
      END_STATE();
    case 282:
      ACCEPT_TOKEN(anon_sym_bool);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 283:
      ACCEPT_TOKEN(anon_sym_string);
      END_STATE();
    case 284:
      ACCEPT_TOKEN(anon_sym_string);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 285:
      ACCEPT_TOKEN(anon_sym_double);
      END_STATE();
    case 286:
      ACCEPT_TOKEN(anon_sym_double);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 287:
      ACCEPT_TOKEN(anon_sym_float);
      END_STATE();
    case 288:
      ACCEPT_TOKEN(anon_sym_float);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 289:
      ACCEPT_TOKEN(anon_sym_bytes);
      END_STATE();
    case 290:
      ACCEPT_TOKEN(anon_sym_bytes);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 291:
      ACCEPT_TOKEN(anon_sym_reserved);
      END_STATE();
    case 292:
      ACCEPT_TOKEN(anon_sym_reserved);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 293:
      ACCEPT_TOKEN(anon_sym_extensions);
      END_STATE();
    case 294:
      ACCEPT_TOKEN(anon_sym_extensions);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 295:
      ACCEPT_TOKEN(anon_sym_to);
      END_STATE();
    case 296:
      ACCEPT_TOKEN(anon_sym_max);
      END_STATE();
    case 297:
      ACCEPT_TOKEN(anon_sym_service);
      END_STATE();
    case 298:
      ACCEPT_TOKEN(anon_sym_rpc);
      END_STATE();
    case 299:
      ACCEPT_TOKEN(anon_sym_stream);
      END_STATE();
    case 300:
      ACCEPT_TOKEN(anon_sym_stream);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 301:
      ACCEPT_TOKEN(anon_sym_returns);
      END_STATE();
    case 302:
      ACCEPT_TOKEN(anon_sym_PLUS);
      END_STATE();
    case 303:
      ACCEPT_TOKEN(anon_sym_COLON);
      END_STATE();
    case 304:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == '2') ADVANCE(262);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 305:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == '2') ADVANCE(270);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 306:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == '2') ADVANCE(266);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 307:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == '2') ADVANCE(274);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 308:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == '2') ADVANCE(278);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 309:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == '3') ADVANCE(304);
      if (lookahead == '6') ADVANCE(314);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 310:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == '3') ADVANCE(305);
      if (lookahead == '6') ADVANCE(315);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 311:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == '3') ADVANCE(306);
      if (lookahead == '6') ADVANCE(316);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 312:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == '3') ADVANCE(307);
      if (lookahead == '6') ADVANCE(317);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 313:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == '3') ADVANCE(308);
      if (lookahead == '6') ADVANCE(318);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 314:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == '4') ADVANCE(264);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 315:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == '4') ADVANCE(272);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 316:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == '4') ADVANCE(268);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 317:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == '4') ADVANCE(276);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 318:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == '4') ADVANCE(280);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 319:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'a') ADVANCE(396);
      if (lookahead == 'e') ADVANCE(411);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('b' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 320:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'a') ADVANCE(357);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('b' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 321:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'a') ADVANCE(372);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('b' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 322:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'a') ADVANCE(367);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('b' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 323:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'a') ADVANCE(416);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('b' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 324:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'a') ADVANCE(369);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('b' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 325:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'a') ADVANCE(373);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('b' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 326:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'a') ADVANCE(420);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('b' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 327:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'b') ADVANCE(370);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 328:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'c') ADVANCE(322);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 329:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'd') ADVANCE(246);
      if (lookahead == 's') ADVANCE(362);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 330:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'd') ADVANCE(252);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 331:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'd') ADVANCE(250);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 332:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'd') ADVANCE(292);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 333:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'd') ADVANCE(312);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 334:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'd') ADVANCE(313);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 335:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'e') ADVANCE(399);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 336:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'e') ADVANCE(333);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 337:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'e') ADVANCE(286);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 338:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'e') ADVANCE(244);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 339:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'e') ADVANCE(437);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 340:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'e') ADVANCE(439);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 341:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'e') ADVANCE(374);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 342:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'e') ADVANCE(330);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 343:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'e') ADVANCE(409);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 344:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'e') ADVANCE(331);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 345:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'e') ADVANCE(402);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 346:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'e') ADVANCE(400);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 347:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'e') ADVANCE(326);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 348:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'e') ADVANCE(332);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 349:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'e') ADVANCE(389);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 350:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'e') ADVANCE(321);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 351:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'e') ADVANCE(413);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 352:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'e') ADVANCE(334);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 353:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'f') ADVANCE(433);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 354:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'f') ADVANCE(256);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 355:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'f') ADVANCE(365);
      if (lookahead == 'i') ADVANCE(383);
      if (lookahead == 't') ADVANCE(403);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 356:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'g') ADVANCE(284);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 357:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'g') ADVANCE(338);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 358:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'i') ADVANCE(431);
      if (lookahead == 'l') ADVANCE(388);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 359:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'i') ADVANCE(381);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 360:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'i') ADVANCE(406);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 361:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'i') ADVANCE(393);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 362:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'i') ADVANCE(394);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 363:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'i') ADVANCE(395);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 364:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'i') ADVANCE(384);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 365:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'i') ADVANCE(432);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 366:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'l') ADVANCE(282);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 367:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'l') ADVANCE(234);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 368:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'l') ADVANCE(248);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 369:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'l') ADVANCE(414);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 370:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'l') ADVANCE(337);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 371:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'm') ADVANCE(236);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 372:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'm') ADVANCE(300);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 373:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'n') ADVANCE(433);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 374:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'n') ADVANCE(329);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 375:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'n') ADVANCE(223);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 376:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'n') ADVANCE(225);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 377:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'n') ADVANCE(349);
      if (lookahead == 'p') ADVANCE(419);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 378:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'n') ADVANCE(415);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 379:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'n') ADVANCE(426);
      if (lookahead == 'x') ADVANCE(398);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 380:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'n') ADVANCE(353);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 381:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'n') ADVANCE(356);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 382:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'n') ADVANCE(410);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 383:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'n') ADVANCE(421);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 384:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'n') ADVANCE(423);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 385:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'o') ADVANCE(425);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 386:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'o') ADVANCE(328);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 387:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'o') ADVANCE(366);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 388:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'o') ADVANCE(323);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 389:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'o') ADVANCE(354);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 390:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'o') ADVANCE(387);
      if (lookahead == 'y') ADVANCE(418);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 391:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'o') ADVANCE(404);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 392:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'o') ADVANCE(427);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 393:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'o') ADVANCE(375);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 394:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'o') ADVANCE(382);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 395:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'o') ADVANCE(376);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 396:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'p') ADVANCE(258);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 397:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'p') ADVANCE(254);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 398:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'p') ADVANCE(391);
      if (lookahead == 't') ADVANCE(341);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 399:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'p') ADVANCE(347);
      if (lookahead == 'q') ADVANCE(428);
      if (lookahead == 's') ADVANCE(345);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 400:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'p') ADVANCE(347);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 401:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'p') ADVANCE(424);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 402:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'r') ADVANCE(430);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 403:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'r') ADVANCE(359);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 404:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'r') ADVANCE(417);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 405:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'r') ADVANCE(429);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 406:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'r') ADVANCE(344);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 407:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'r') ADVANCE(350);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 408:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'r') ADVANCE(392);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 409:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 's') ADVANCE(290);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 410:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 's') ADVANCE(294);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 411:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 's') ADVANCE(412);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 412:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 's') ADVANCE(320);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 413:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 's') ADVANCE(345);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 414:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 's') ADVANCE(340);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 415:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 't') ADVANCE(309);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 416:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 't') ADVANCE(288);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 417:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 't') ADVANCE(232);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 418:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 't') ADVANCE(343);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 419:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 't') ADVANCE(361);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 420:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 't') ADVANCE(342);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 421:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 't') ADVANCE(310);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 422:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 't') ADVANCE(407);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 423:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 't') ADVANCE(311);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 424:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 't') ADVANCE(363);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 425:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'u') ADVANCE(327);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 426:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'u') ADVANCE(371);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 427:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'u') ADVANCE(397);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 428:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'u') ADVANCE(360);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 429:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'u') ADVANCE(339);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 430:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'v') ADVANCE(348);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 431:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'x') ADVANCE(336);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 432:
      ACCEPT_TOKEN(sym_identifier);
      if (lookahead == 'x') ADVANCE(352);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 433:
      ACCEPT_TOKEN(sym_identifier);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 434:
      ACCEPT_TOKEN(sym_reserved_identifier);
      END_STATE();
    case 435:
      ACCEPT_TOKEN(sym_reserved_identifier);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(435);
      END_STATE();
    case 436:
      ACCEPT_TOKEN(sym_true);
      END_STATE();
    case 437:
      ACCEPT_TOKEN(sym_true);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 438:
      ACCEPT_TOKEN(sym_false);
      END_STATE();
    case 439:
      ACCEPT_TOKEN(sym_false);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'Z') ||
          lookahead == '_' ||
          ('a' <= lookahead && lookahead <= 'z')) ADVANCE(433);
      END_STATE();
    case 440:
      ACCEPT_TOKEN(sym_decimal_lit);
      if (lookahead == '.') ADVANCE(448);
      if (lookahead == 'E' ||
          lookahead == 'e') ADVANCE(196);
      if (('0' <= lookahead && lookahead <= '9')) ADVANCE(440);
      END_STATE();
    case 441:
      ACCEPT_TOKEN(sym_decimal_lit);
      if (('0' <= lookahead && lookahead <= '9')) ADVANCE(441);
      END_STATE();
    case 442:
      ACCEPT_TOKEN(sym_octal_lit);
      if (lookahead == '.') ADVANCE(448);
      if (lookahead == 'E' ||
          lookahead == 'e') ADVANCE(196);
      if (lookahead == 'X' ||
          lookahead == 'x') ADVANCE(200);
      if (lookahead == '8' ||
          lookahead == '9') ADVANCE(14);
      if (('0' <= lookahead && lookahead <= '7')) ADVANCE(443);
      END_STATE();
    case 443:
      ACCEPT_TOKEN(sym_octal_lit);
      if (lookahead == '.') ADVANCE(448);
      if (lookahead == 'E' ||
          lookahead == 'e') ADVANCE(196);
      if (lookahead == '8' ||
          lookahead == '9') ADVANCE(14);
      if (('0' <= lookahead && lookahead <= '7')) ADVANCE(443);
      END_STATE();
    case 444:
      ACCEPT_TOKEN(sym_octal_lit);
      if (lookahead == 'X' ||
          lookahead == 'x') ADVANCE(200);
      if (('0' <= lookahead && lookahead <= '7')) ADVANCE(445);
      END_STATE();
    case 445:
      ACCEPT_TOKEN(sym_octal_lit);
      if (('0' <= lookahead && lookahead <= '7')) ADVANCE(445);
      END_STATE();
    case 446:
      ACCEPT_TOKEN(sym_hex_lit);
      if (('0' <= lookahead && lookahead <= '9') ||
          ('A' <= lookahead && lookahead <= 'F') ||
          ('a' <= lookahead && lookahead <= 'f')) ADVANCE(446);
      END_STATE();
    case 447:
      ACCEPT_TOKEN(sym_float_lit);
      END_STATE();
    case 448:
      ACCEPT_TOKEN(sym_float_lit);
      if (lookahead == 'E' ||
          lookahead == 'e') ADVANCE(196);
      if (('0' <= lookahead && lookahead <= '9')) ADVANCE(448);
      END_STATE();
    case 449:
      ACCEPT_TOKEN(sym_float_lit);
      if (('0' <= lookahead && lookahead <= '9')) ADVANCE(449);
      END_STATE();
    case 450:
      ACCEPT_TOKEN(anon_sym_DQUOTE);
      END_STATE();
    case 451:
      ACCEPT_TOKEN(aux_sym_string_token1);
      if (lookahead == '\n') ADVANCE(456);
      if (lookahead != 0 &&
          lookahead != '"' &&
          lookahead != '\\') ADVANCE(451);
      END_STATE();
    case 452:
      ACCEPT_TOKEN(aux_sym_string_token1);
      if (lookahead == '*') ADVANCE(454);
      if (lookahead == '/') ADVANCE(451);
      if (lookahead != 0 &&
          lookahead != '"' &&
          lookahead != '\\') ADVANCE(456);
      END_STATE();
    case 453:
      ACCEPT_TOKEN(aux_sym_string_token1);
      if (lookahead == '*') ADVANCE(453);
      if (lookahead == '/') ADVANCE(456);
      if (lookahead != 0 &&
          lookahead != '"' &&
          lookahead != '\\') ADVANCE(454);
      END_STATE();
    case 454:
      ACCEPT_TOKEN(aux_sym_string_token1);
      if (lookahead == '*') ADVANCE(453);
      if (lookahead != 0 &&
          lookahead != '"' &&
          lookahead != '\\') ADVANCE(454);
      END_STATE();
    case 455:
      ACCEPT_TOKEN(aux_sym_string_token1);
      if (lookahead == '/') ADVANCE(452);
      if (('\t' <= lookahead && lookahead <= '\r') ||
          lookahead == ' ') ADVANCE(455);
      if (lookahead != 0 &&
          lookahead != '"' &&
          lookahead != '\\') ADVANCE(456);
      END_STATE();
    case 456:
      ACCEPT_TOKEN(aux_sym_string_token1);
      if (lookahead != 0 &&
          lookahead != '"' &&
          lookahead != '\\') ADVANCE(456);
      END_STATE();
    case 457:
      ACCEPT_TOKEN(anon_sym_SQUOTE);
      END_STATE();
    case 458:
      ACCEPT_TOKEN(aux_sym_string_token2);
      if (lookahead == '\n') ADVANCE(463);
      if (lookahead != 0 &&
          lookahead != '\'' &&
          lookahead != '\\') ADVANCE(458);
      END_STATE();
    case 459:
      ACCEPT_TOKEN(aux_sym_string_token2);
      if (lookahead == '*') ADVANCE(461);
      if (lookahead == '/') ADVANCE(458);
      if (lookahead != 0 &&
          lookahead != '\'' &&
          lookahead != '\\') ADVANCE(463);
      END_STATE();
    case 460:
      ACCEPT_TOKEN(aux_sym_string_token2);
      if (lookahead == '*') ADVANCE(460);
      if (lookahead == '/') ADVANCE(463);
      if (lookahead != 0 &&
          lookahead != '\'' &&
          lookahead != '\\') ADVANCE(461);
      END_STATE();
    case 461:
      ACCEPT_TOKEN(aux_sym_string_token2);
      if (lookahead == '*') ADVANCE(460);
      if (lookahead != 0 &&
          lookahead != '\'' &&
          lookahead != '\\') ADVANCE(461);
      END_STATE();
    case 462:
      ACCEPT_TOKEN(aux_sym_string_token2);
      if (lookahead == '/') ADVANCE(459);
      if (('\t' <= lookahead && lookahead <= '\r') ||
          lookahead == ' ') ADVANCE(462);
      if (lookahead != 0 &&
          lookahead != '\'' &&
          lookahead != '\\') ADVANCE(463);
      END_STATE();
    case 463:
      ACCEPT_TOKEN(aux_sym_string_token2);
      if (lookahead != 0 &&
          lookahead != '\'' &&
          lookahead != '\\') ADVANCE(463);
      END_STATE();
    case 464:
      ACCEPT_TOKEN(sym_escape_sequence);
      END_STATE();
    case 465:
      ACCEPT_TOKEN(sym_escape_sequence);
      if (('0' <= lookahead && lookahead <= '9')) ADVANCE(464);
      END_STATE();
    case 466:
      ACCEPT_TOKEN(sym_escape_sequence);
      if (('0' <= lookahead && lookahead <= '9')) ADVANCE(465);
      END_STATE();
    case 467:
      ACCEPT_TOKEN(sym_comment);
      END_STATE();
    case 468:
      ACCEPT_TOKEN(sym_comment);
      if (lookahead != 0 &&
          lookahead != '\n') ADVANCE(468);
      END_STATE();
    default:
      return false;
  }
}

static const TSLexMode ts_lex_modes[STATE_COUNT] = {
  [0] = {.lex_state = 0},
  [1] = {.lex_state = 211},
  [2] = {.lex_state = 8},
  [3] = {.lex_state = 8},
  [4] = {.lex_state = 8},
  [5] = {.lex_state = 8},
  [6] = {.lex_state = 8},
  [7] = {.lex_state = 8},
  [8] = {.lex_state = 8},
  [9] = {.lex_state = 8},
  [10] = {.lex_state = 8},
  [11] = {.lex_state = 8},
  [12] = {.lex_state = 8},
  [13] = {.lex_state = 8},
  [14] = {.lex_state = 8},
  [15] = {.lex_state = 8},
  [16] = {.lex_state = 8},
  [17] = {.lex_state = 8},
  [18] = {.lex_state = 8},
  [19] = {.lex_state = 8},
  [20] = {.lex_state = 8},
  [21] = {.lex_state = 8},
  [22] = {.lex_state = 8},
  [23] = {.lex_state = 8},
  [24] = {.lex_state = 8},
  [25] = {.lex_state = 8},
  [26] = {.lex_state = 8},
  [27] = {.lex_state = 8},
  [28] = {.lex_state = 8},
  [29] = {.lex_state = 8},
  [30] = {.lex_state = 8},
  [31] = {.lex_state = 8},
  [32] = {.lex_state = 15},
  [33] = {.lex_state = 15},
  [34] = {.lex_state = 15},
  [35] = {.lex_state = 16},
  [36] = {.lex_state = 15},
  [37] = {.lex_state = 15},
  [38] = {.lex_state = 17},
  [39] = {.lex_state = 15},
  [40] = {.lex_state = 2},
  [41] = {.lex_state = 2},
  [42] = {.lex_state = 211},
  [43] = {.lex_state = 18},
  [44] = {.lex_state = 211},
  [45] = {.lex_state = 211},
  [46] = {.lex_state = 2},
  [47] = {.lex_state = 2},
  [48] = {.lex_state = 2},
  [49] = {.lex_state = 18},
  [50] = {.lex_state = 2},
  [51] = {.lex_state = 2},
  [52] = {.lex_state = 15},
  [53] = {.lex_state = 211},
  [54] = {.lex_state = 2},
  [55] = {.lex_state = 15},
  [56] = {.lex_state = 15},
  [57] = {.lex_state = 2},
  [58] = {.lex_state = 2},
  [59] = {.lex_state = 2},
  [60] = {.lex_state = 2},
  [61] = {.lex_state = 2},
  [62] = {.lex_state = 2},
  [63] = {.lex_state = 2},
  [64] = {.lex_state = 211},
  [65] = {.lex_state = 0},
  [66] = {.lex_state = 211},
  [67] = {.lex_state = 211},
  [68] = {.lex_state = 211},
  [69] = {.lex_state = 211},
  [70] = {.lex_state = 211},
  [71] = {.lex_state = 211},
  [72] = {.lex_state = 211},
  [73] = {.lex_state = 211},
  [74] = {.lex_state = 211},
  [75] = {.lex_state = 211},
  [76] = {.lex_state = 211},
  [77] = {.lex_state = 211},
  [78] = {.lex_state = 1},
  [79] = {.lex_state = 211},
  [80] = {.lex_state = 211},
  [81] = {.lex_state = 211},
  [82] = {.lex_state = 211},
  [83] = {.lex_state = 211},
  [84] = {.lex_state = 1},
  [85] = {.lex_state = 21},
  [86] = {.lex_state = 21},
  [87] = {.lex_state = 21},
  [88] = {.lex_state = 21},
  [89] = {.lex_state = 1},
  [90] = {.lex_state = 1},
  [91] = {.lex_state = 21},
  [92] = {.lex_state = 1},
  [93] = {.lex_state = 1},
  [94] = {.lex_state = 1},
  [95] = {.lex_state = 6},
  [96] = {.lex_state = 211},
  [97] = {.lex_state = 1},
  [98] = {.lex_state = 6},
  [99] = {.lex_state = 211},
  [100] = {.lex_state = 211},
  [101] = {.lex_state = 211},
  [102] = {.lex_state = 211},
  [103] = {.lex_state = 211},
  [104] = {.lex_state = 211},
  [105] = {.lex_state = 211},
  [106] = {.lex_state = 211},
  [107] = {.lex_state = 211},
  [108] = {.lex_state = 211},
  [109] = {.lex_state = 0},
  [110] = {.lex_state = 1},
  [111] = {.lex_state = 1},
  [112] = {.lex_state = 1},
  [113] = {.lex_state = 211},
  [114] = {.lex_state = 1},
  [115] = {.lex_state = 1},
  [116] = {.lex_state = 20},
  [117] = {.lex_state = 1},
  [118] = {.lex_state = 1},
  [119] = {.lex_state = 211},
  [120] = {.lex_state = 19},
  [121] = {.lex_state = 1},
  [122] = {.lex_state = 1},
  [123] = {.lex_state = 21},
  [124] = {.lex_state = 21},
  [125] = {.lex_state = 1},
  [126] = {.lex_state = 211},
  [127] = {.lex_state = 1},
  [128] = {.lex_state = 1},
  [129] = {.lex_state = 211},
  [130] = {.lex_state = 211},
  [131] = {.lex_state = 21},
  [132] = {.lex_state = 211},
  [133] = {.lex_state = 21},
  [134] = {.lex_state = 1},
  [135] = {.lex_state = 211},
  [136] = {.lex_state = 21},
  [137] = {.lex_state = 1},
  [138] = {.lex_state = 21},
  [139] = {.lex_state = 1},
  [140] = {.lex_state = 211},
  [141] = {.lex_state = 1},
  [142] = {.lex_state = 1},
  [143] = {.lex_state = 211},
  [144] = {.lex_state = 20},
  [145] = {.lex_state = 211},
  [146] = {.lex_state = 21},
  [147] = {.lex_state = 1},
  [148] = {.lex_state = 21},
  [149] = {.lex_state = 211},
  [150] = {.lex_state = 19},
  [151] = {.lex_state = 19},
  [152] = {.lex_state = 9},
  [153] = {.lex_state = 1},
  [154] = {.lex_state = 1},
  [155] = {.lex_state = 1},
  [156] = {.lex_state = 1},
  [157] = {.lex_state = 1},
  [158] = {.lex_state = 1},
  [159] = {.lex_state = 3},
  [160] = {.lex_state = 9},
  [161] = {.lex_state = 1},
  [162] = {.lex_state = 1},
  [163] = {.lex_state = 1},
  [164] = {.lex_state = 1},
  [165] = {.lex_state = 1},
  [166] = {.lex_state = 0},
  [167] = {.lex_state = 211},
  [168] = {.lex_state = 211},
  [169] = {.lex_state = 211},
  [170] = {.lex_state = 211},
  [171] = {.lex_state = 211},
  [172] = {.lex_state = 0},
  [173] = {.lex_state = 3},
  [174] = {.lex_state = 1},
  [175] = {.lex_state = 211},
  [176] = {.lex_state = 1},
  [177] = {.lex_state = 3},
  [178] = {.lex_state = 9},
  [179] = {.lex_state = 0},
  [180] = {.lex_state = 0},
  [181] = {.lex_state = 0},
  [182] = {.lex_state = 0},
  [183] = {.lex_state = 0},
  [184] = {.lex_state = 0},
  [185] = {.lex_state = 1},
  [186] = {.lex_state = 0},
  [187] = {.lex_state = 0},
  [188] = {.lex_state = 1},
  [189] = {.lex_state = 0},
  [190] = {.lex_state = 211},
  [191] = {.lex_state = 0},
  [192] = {.lex_state = 0},
  [193] = {.lex_state = 1},
  [194] = {.lex_state = 0},
  [195] = {.lex_state = 0},
  [196] = {.lex_state = 1},
  [197] = {.lex_state = 0},
  [198] = {.lex_state = 1},
  [199] = {.lex_state = 0},
  [200] = {.lex_state = 0},
  [201] = {.lex_state = 0},
  [202] = {.lex_state = 0},
  [203] = {.lex_state = 0},
  [204] = {.lex_state = 1},
  [205] = {.lex_state = 1},
  [206] = {.lex_state = 1},
  [207] = {.lex_state = 0},
  [208] = {.lex_state = 211},
  [209] = {.lex_state = 0},
  [210] = {.lex_state = 0},
  [211] = {.lex_state = 1},
  [212] = {.lex_state = 211},
  [213] = {.lex_state = 0},
  [214] = {.lex_state = 211},
  [215] = {.lex_state = 1},
  [216] = {.lex_state = 1},
  [217] = {.lex_state = 0},
  [218] = {.lex_state = 0},
  [219] = {.lex_state = 0},
  [220] = {.lex_state = 0},
  [221] = {.lex_state = 1},
  [222] = {.lex_state = 0},
  [223] = {.lex_state = 0},
  [224] = {.lex_state = 1},
  [225] = {.lex_state = 1},
  [226] = {.lex_state = 1},
  [227] = {.lex_state = 1},
  [228] = {.lex_state = 1},
  [229] = {.lex_state = 0},
  [230] = {.lex_state = 0},
  [231] = {.lex_state = 0},
  [232] = {.lex_state = 0},
  [233] = {.lex_state = 0},
  [234] = {.lex_state = 0},
  [235] = {.lex_state = 0},
  [236] = {.lex_state = 1},
  [237] = {.lex_state = 1},
  [238] = {.lex_state = 0},
  [239] = {.lex_state = 1},
  [240] = {.lex_state = 0},
  [241] = {.lex_state = 1},
  [242] = {.lex_state = 1},
  [243] = {.lex_state = 0},
  [244] = {.lex_state = 0},
  [245] = {.lex_state = 8},
  [246] = {.lex_state = 1},
  [247] = {.lex_state = 0},
  [248] = {.lex_state = 1},
  [249] = {.lex_state = 1},
  [250] = {.lex_state = 1},
  [251] = {.lex_state = 0},
  [252] = {.lex_state = 0},
  [253] = {.lex_state = 0},
  [254] = {.lex_state = 0},
  [255] = {.lex_state = 1},
  [256] = {.lex_state = 0},
  [257] = {.lex_state = 0},
  [258] = {.lex_state = 0},
  [259] = {.lex_state = 0},
  [260] = {.lex_state = 0},
  [261] = {.lex_state = 0},
  [262] = {.lex_state = 0},
  [263] = {.lex_state = 1},
  [264] = {.lex_state = 1},
  [265] = {.lex_state = 1},
  [266] = {.lex_state = 1},
  [267] = {.lex_state = 1},
  [268] = {.lex_state = 0},
  [269] = {.lex_state = 0},
  [270] = {.lex_state = 0},
  [271] = {.lex_state = 1},
  [272] = {.lex_state = 0},
  [273] = {.lex_state = 0},
  [274] = {.lex_state = 0},
  [275] = {.lex_state = 0},
  [276] = {.lex_state = 1},
  [277] = {.lex_state = 0},
  [278] = {.lex_state = 0},
  [279] = {.lex_state = 0},
  [280] = {.lex_state = 0},
  [281] = {.lex_state = 0},
  [282] = {.lex_state = 211},
  [283] = {.lex_state = 0},
  [284] = {.lex_state = 0},
  [285] = {.lex_state = 0},
  [286] = {.lex_state = 0},
  [287] = {.lex_state = 0},
  [288] = {.lex_state = 0},
  [289] = {.lex_state = 1},
  [290] = {.lex_state = 0},
  [291] = {.lex_state = 0},
  [292] = {.lex_state = 1},
  [293] = {.lex_state = 0},
  [294] = {.lex_state = 0},
  [295] = {.lex_state = 0},
  [296] = {.lex_state = 0},
  [297] = {.lex_state = 0},
  [298] = {.lex_state = 0},
  [299] = {.lex_state = 1},
  [300] = {.lex_state = 0},
  [301] = {.lex_state = 0},
  [302] = {.lex_state = 0},
  [303] = {.lex_state = 0},
  [304] = {.lex_state = 0},
  [305] = {.lex_state = 0},
  [306] = {.lex_state = 6},
  [307] = {.lex_state = 0},
  [308] = {.lex_state = 0},
  [309] = {.lex_state = 0},
  [310] = {.lex_state = 0},
  [311] = {.lex_state = 0},
  [312] = {.lex_state = 0},
  [313] = {.lex_state = 0},
  [314] = {.lex_state = 0},
  [315] = {.lex_state = 1},
  [316] = {.lex_state = 0},
  [317] = {.lex_state = 0},
  [318] = {.lex_state = 0},
  [319] = {.lex_state = 0},
  [320] = {.lex_state = 1},
  [321] = {.lex_state = 0},
  [322] = {.lex_state = 0},
  [323] = {.lex_state = 0},
  [324] = {.lex_state = 0},
  [325] = {.lex_state = 0},
  [326] = {.lex_state = 0},
  [327] = {.lex_state = 0},
  [328] = {.lex_state = 0},
  [329] = {.lex_state = 0},
  [330] = {.lex_state = 0},
  [331] = {.lex_state = 0},
  [332] = {.lex_state = 0},
  [333] = {.lex_state = 0},
  [334] = {.lex_state = 0},
  [335] = {.lex_state = 0},
  [336] = {.lex_state = 1},
  [337] = {.lex_state = 0},
  [338] = {.lex_state = 0},
  [339] = {.lex_state = 0},
  [340] = {.lex_state = 0},
  [341] = {.lex_state = 0},
  [342] = {.lex_state = 1},
  [343] = {.lex_state = 0},
  [344] = {.lex_state = 0},
};

static const uint16_t ts_parse_table[LARGE_STATE_COUNT][SYMBOL_COUNT] = {
  [0] = {
    [ts_builtin_sym_end] = ACTIONS(1),
    [anon_sym_SEMI] = ACTIONS(1),
    [anon_sym_edition] = ACTIONS(1),
    [anon_sym_EQ] = ACTIONS(1),
    [anon_sym_syntax] = ACTIONS(1),
    [anon_sym_import] = ACTIONS(1),
    [anon_sym_weak] = ACTIONS(1),
    [anon_sym_public] = ACTIONS(1),
    [anon_sym_option] = ACTIONS(1),
    [anon_sym_package] = ACTIONS(1),
    [anon_sym_LPAREN] = ACTIONS(1),
    [anon_sym_RPAREN] = ACTIONS(1),
    [anon_sym_DOT] = ACTIONS(1),
    [anon_sym_export] = ACTIONS(1),
    [anon_sym_local] = ACTIONS(1),
    [anon_sym_enum] = ACTIONS(1),
    [anon_sym_LBRACE] = ACTIONS(1),
    [anon_sym_RBRACE] = ACTIONS(1),
    [anon_sym_DASH] = ACTIONS(1),
    [anon_sym_LBRACK] = ACTIONS(1),
    [anon_sym_COMMA] = ACTIONS(1),
    [anon_sym_RBRACK] = ACTIONS(1),
    [anon_sym_message] = ACTIONS(1),
    [anon_sym_extend] = ACTIONS(1),
    [anon_sym_optional] = ACTIONS(1),
    [anon_sym_required] = ACTIONS(1),
    [anon_sym_repeated] = ACTIONS(1),
    [anon_sym_group] = ACTIONS(1),
    [anon_sym_oneof] = ACTIONS(1),
    [anon_sym_map] = ACTIONS(1),
    [anon_sym_LT] = ACTIONS(1),
    [anon_sym_GT] = ACTIONS(1),
    [anon_sym_int32] = ACTIONS(1),
    [anon_sym_int64] = ACTIONS(1),
    [anon_sym_uint32] = ACTIONS(1),
    [anon_sym_uint64] = ACTIONS(1),
    [anon_sym_sint32] = ACTIONS(1),
    [anon_sym_sint64] = ACTIONS(1),
    [anon_sym_fixed32] = ACTIONS(1),
    [anon_sym_fixed64] = ACTIONS(1),
    [anon_sym_sfixed32] = ACTIONS(1),
    [anon_sym_sfixed64] = ACTIONS(1),
    [anon_sym_bool] = ACTIONS(1),
    [anon_sym_string] = ACTIONS(1),
    [anon_sym_double] = ACTIONS(1),
    [anon_sym_float] = ACTIONS(1),
    [anon_sym_bytes] = ACTIONS(1),
    [anon_sym_reserved] = ACTIONS(1),
    [anon_sym_extensions] = ACTIONS(1),
    [anon_sym_to] = ACTIONS(1),
    [anon_sym_max] = ACTIONS(1),
    [anon_sym_service] = ACTIONS(1),
    [anon_sym_rpc] = ACTIONS(1),
    [anon_sym_stream] = ACTIONS(1),
    [anon_sym_returns] = ACTIONS(1),
    [anon_sym_PLUS] = ACTIONS(1),
    [anon_sym_COLON] = ACTIONS(1),
    [sym_true] = ACTIONS(1),
    [sym_false] = ACTIONS(1),
    [sym_decimal_lit] = ACTIONS(1),
    [sym_octal_lit] = ACTIONS(1),
    [sym_hex_lit] = ACTIONS(1),
    [sym_float_lit] = ACTIONS(1),
    [anon_sym_DQUOTE] = ACTIONS(1),
    [anon_sym_SQUOTE] = ACTIONS(1),
    [sym_escape_sequence] = ACTIONS(1),
    [sym_comment] = ACTIONS(3),
  },
  [1] = {
    [sym_source_file] = STATE(319),
    [sym_empty_statement] = STATE(53),
    [sym_edition] = STATE(44),
    [sym_syntax] = STATE(44),
    [sym_import] = STATE(53),
    [sym_package] = STATE(53),
    [sym_option] = STATE(53),
    [sym_enum] = STATE(53),
    [sym_message] = STATE(53),
    [sym_extend] = STATE(53),
    [sym_service] = STATE(53),
    [aux_sym_source_file_repeat1] = STATE(53),
    [ts_builtin_sym_end] = ACTIONS(5),
    [anon_sym_SEMI] = ACTIONS(7),
    [anon_sym_edition] = ACTIONS(9),
    [anon_sym_syntax] = ACTIONS(11),
    [anon_sym_import] = ACTIONS(13),
    [anon_sym_option] = ACTIONS(15),
    [anon_sym_package] = ACTIONS(17),
    [anon_sym_export] = ACTIONS(19),
    [anon_sym_local] = ACTIONS(19),
    [anon_sym_enum] = ACTIONS(21),
    [anon_sym_message] = ACTIONS(23),
    [anon_sym_extend] = ACTIONS(25),
    [anon_sym_service] = ACTIONS(27),
    [sym_comment] = ACTIONS(3),
  },
};

static const uint16_t ts_small_parse_table[] = {
  [0] = 22,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(29), 1,
      anon_sym_SEMI,
    ACTIONS(31), 1,
      anon_sym_option,
    ACTIONS(33), 1,
      anon_sym_DOT,
    ACTIONS(37), 1,
      anon_sym_enum,
    ACTIONS(39), 1,
      anon_sym_RBRACE,
    ACTIONS(41), 1,
      anon_sym_message,
    ACTIONS(43), 1,
      anon_sym_extend,
    ACTIONS(47), 1,
      anon_sym_repeated,
    ACTIONS(49), 1,
      anon_sym_group,
    ACTIONS(51), 1,
      anon_sym_oneof,
    ACTIONS(53), 1,
      anon_sym_map,
    ACTIONS(57), 1,
      anon_sym_reserved,
    ACTIONS(59), 1,
      anon_sym_extensions,
    ACTIONS(61), 1,
      sym_identifier,
    STATE(241), 1,
      sym_message_or_enum_type,
    STATE(271), 1,
      aux_sym_message_or_enum_type_repeat1,
    STATE(299), 1,
      sym_type,
    ACTIONS(35), 2,
      anon_sym_export,
      anon_sym_local,
    ACTIONS(45), 2,
      anon_sym_optional,
      anon_sym_required,
    STATE(3), 12,
      sym_empty_statement,
      sym_option,
      sym_enum,
      sym_message,
      sym_extend,
      sym_group,
      sym_field,
      sym_oneof,
      sym_map_field,
      sym_reserved,
      sym_extensions,
      aux_sym_message_body_repeat1,
    ACTIONS(55), 15,
      anon_sym_int32,
      anon_sym_int64,
      anon_sym_uint32,
      anon_sym_uint64,
      anon_sym_sint32,
      anon_sym_sint64,
      anon_sym_fixed32,
      anon_sym_fixed64,
      anon_sym_sfixed32,
      anon_sym_sfixed64,
      anon_sym_bool,
      anon_sym_string,
      anon_sym_double,
      anon_sym_float,
      anon_sym_bytes,
  [94] = 22,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(29), 1,
      anon_sym_SEMI,
    ACTIONS(31), 1,
      anon_sym_option,
    ACTIONS(33), 1,
      anon_sym_DOT,
    ACTIONS(37), 1,
      anon_sym_enum,
    ACTIONS(41), 1,
      anon_sym_message,
    ACTIONS(43), 1,
      anon_sym_extend,
    ACTIONS(47), 1,
      anon_sym_repeated,
    ACTIONS(49), 1,
      anon_sym_group,
    ACTIONS(51), 1,
      anon_sym_oneof,
    ACTIONS(53), 1,
      anon_sym_map,
    ACTIONS(57), 1,
      anon_sym_reserved,
    ACTIONS(59), 1,
      anon_sym_extensions,
    ACTIONS(61), 1,
      sym_identifier,
    ACTIONS(63), 1,
      anon_sym_RBRACE,
    STATE(241), 1,
      sym_message_or_enum_type,
    STATE(271), 1,
      aux_sym_message_or_enum_type_repeat1,
    STATE(299), 1,
      sym_type,
    ACTIONS(35), 2,
      anon_sym_export,
      anon_sym_local,
    ACTIONS(45), 2,
      anon_sym_optional,
      anon_sym_required,
    STATE(4), 12,
      sym_empty_statement,
      sym_option,
      sym_enum,
      sym_message,
      sym_extend,
      sym_group,
      sym_field,
      sym_oneof,
      sym_map_field,
      sym_reserved,
      sym_extensions,
      aux_sym_message_body_repeat1,
    ACTIONS(55), 15,
      anon_sym_int32,
      anon_sym_int64,
      anon_sym_uint32,
      anon_sym_uint64,
      anon_sym_sint32,
      anon_sym_sint64,
      anon_sym_fixed32,
      anon_sym_fixed64,
      anon_sym_sfixed32,
      anon_sym_sfixed64,
      anon_sym_bool,
      anon_sym_string,
      anon_sym_double,
      anon_sym_float,
      anon_sym_bytes,
  [188] = 22,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(65), 1,
      anon_sym_SEMI,
    ACTIONS(68), 1,
      anon_sym_option,
    ACTIONS(71), 1,
      anon_sym_DOT,
    ACTIONS(77), 1,
      anon_sym_enum,
    ACTIONS(80), 1,
      anon_sym_RBRACE,
    ACTIONS(82), 1,
      anon_sym_message,
    ACTIONS(85), 1,
      anon_sym_extend,
    ACTIONS(91), 1,
      anon_sym_repeated,
    ACTIONS(94), 1,
      anon_sym_group,
    ACTIONS(97), 1,
      anon_sym_oneof,
    ACTIONS(100), 1,
      anon_sym_map,
    ACTIONS(106), 1,
      anon_sym_reserved,
    ACTIONS(109), 1,
      anon_sym_extensions,
    ACTIONS(112), 1,
      sym_identifier,
    STATE(241), 1,
      sym_message_or_enum_type,
    STATE(271), 1,
      aux_sym_message_or_enum_type_repeat1,
    STATE(299), 1,
      sym_type,
    ACTIONS(74), 2,
      anon_sym_export,
      anon_sym_local,
    ACTIONS(88), 2,
      anon_sym_optional,
      anon_sym_required,
    STATE(4), 12,
      sym_empty_statement,
      sym_option,
      sym_enum,
      sym_message,
      sym_extend,
      sym_group,
      sym_field,
      sym_oneof,
      sym_map_field,
      sym_reserved,
      sym_extensions,
      aux_sym_message_body_repeat1,
    ACTIONS(103), 15,
      anon_sym_int32,
      anon_sym_int64,
      anon_sym_uint32,
      anon_sym_uint64,
      anon_sym_sint32,
      anon_sym_sint64,
      anon_sym_fixed32,
      anon_sym_fixed64,
      anon_sym_sfixed32,
      anon_sym_sfixed64,
      anon_sym_bool,
      anon_sym_string,
      anon_sym_double,
      anon_sym_float,
      anon_sym_bytes,
  [282] = 22,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(29), 1,
      anon_sym_SEMI,
    ACTIONS(31), 1,
      anon_sym_option,
    ACTIONS(33), 1,
      anon_sym_DOT,
    ACTIONS(37), 1,
      anon_sym_enum,
    ACTIONS(41), 1,
      anon_sym_message,
    ACTIONS(43), 1,
      anon_sym_extend,
    ACTIONS(47), 1,
      anon_sym_repeated,
    ACTIONS(49), 1,
      anon_sym_group,
    ACTIONS(51), 1,
      anon_sym_oneof,
    ACTIONS(53), 1,
      anon_sym_map,
    ACTIONS(57), 1,
      anon_sym_reserved,
    ACTIONS(59), 1,
      anon_sym_extensions,
    ACTIONS(61), 1,
      sym_identifier,
    ACTIONS(115), 1,
      anon_sym_RBRACE,
    STATE(241), 1,
      sym_message_or_enum_type,
    STATE(271), 1,
      aux_sym_message_or_enum_type_repeat1,
    STATE(299), 1,
      sym_type,
    ACTIONS(35), 2,
      anon_sym_export,
      anon_sym_local,
    ACTIONS(45), 2,
      anon_sym_optional,
      anon_sym_required,
    STATE(4), 12,
      sym_empty_statement,
      sym_option,
      sym_enum,
      sym_message,
      sym_extend,
      sym_group,
      sym_field,
      sym_oneof,
      sym_map_field,
      sym_reserved,
      sym_extensions,
      aux_sym_message_body_repeat1,
    ACTIONS(55), 15,
      anon_sym_int32,
      anon_sym_int64,
      anon_sym_uint32,
      anon_sym_uint64,
      anon_sym_sint32,
      anon_sym_sint64,
      anon_sym_fixed32,
      anon_sym_fixed64,
      anon_sym_sfixed32,
      anon_sym_sfixed64,
      anon_sym_bool,
      anon_sym_string,
      anon_sym_double,
      anon_sym_float,
      anon_sym_bytes,
  [376] = 22,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(29), 1,
      anon_sym_SEMI,
    ACTIONS(31), 1,
      anon_sym_option,
    ACTIONS(33), 1,
      anon_sym_DOT,
    ACTIONS(37), 1,
      anon_sym_enum,
    ACTIONS(41), 1,
      anon_sym_message,
    ACTIONS(43), 1,
      anon_sym_extend,
    ACTIONS(47), 1,
      anon_sym_repeated,
    ACTIONS(49), 1,
      anon_sym_group,
    ACTIONS(51), 1,
      anon_sym_oneof,
    ACTIONS(53), 1,
      anon_sym_map,
    ACTIONS(57), 1,
      anon_sym_reserved,
    ACTIONS(59), 1,
      anon_sym_extensions,
    ACTIONS(61), 1,
      sym_identifier,
    ACTIONS(117), 1,
      anon_sym_RBRACE,
    STATE(241), 1,
      sym_message_or_enum_type,
    STATE(271), 1,
      aux_sym_message_or_enum_type_repeat1,
    STATE(299), 1,
      sym_type,
    ACTIONS(35), 2,
      anon_sym_export,
      anon_sym_local,
    ACTIONS(45), 2,
      anon_sym_optional,
      anon_sym_required,
    STATE(5), 12,
      sym_empty_statement,
      sym_option,
      sym_enum,
      sym_message,
      sym_extend,
      sym_group,
      sym_field,
      sym_oneof,
      sym_map_field,
      sym_reserved,
      sym_extensions,
      aux_sym_message_body_repeat1,
    ACTIONS(55), 15,
      anon_sym_int32,
      anon_sym_int64,
      anon_sym_uint32,
      anon_sym_uint64,
      anon_sym_sint32,
      anon_sym_sint64,
      anon_sym_fixed32,
      anon_sym_fixed64,
      anon_sym_sfixed32,
      anon_sym_sfixed64,
      anon_sym_bool,
      anon_sym_string,
      anon_sym_double,
      anon_sym_float,
      anon_sym_bytes,
  [470] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(119), 3,
      anon_sym_SEMI,
      anon_sym_DOT,
      anon_sym_RBRACE,
    ACTIONS(121), 30,
      anon_sym_option,
      anon_sym_export,
      anon_sym_local,
      anon_sym_enum,
      anon_sym_message,
      anon_sym_extend,
      anon_sym_optional,
      anon_sym_required,
      anon_sym_repeated,
      anon_sym_group,
      anon_sym_oneof,
      anon_sym_map,
      anon_sym_int32,
      anon_sym_int64,
      anon_sym_uint32,
      anon_sym_uint64,
      anon_sym_sint32,
      anon_sym_sint64,
      anon_sym_fixed32,
      anon_sym_fixed64,
      anon_sym_sfixed32,
      anon_sym_sfixed64,
      anon_sym_bool,
      anon_sym_string,
      anon_sym_double,
      anon_sym_float,
      anon_sym_bytes,
      anon_sym_reserved,
      anon_sym_extensions,
      sym_identifier,
  [511] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(123), 3,
      anon_sym_SEMI,
      anon_sym_DOT,
      anon_sym_RBRACE,
    ACTIONS(125), 30,
      anon_sym_option,
      anon_sym_export,
      anon_sym_local,
      anon_sym_enum,
      anon_sym_message,
      anon_sym_extend,
      anon_sym_optional,
      anon_sym_required,
      anon_sym_repeated,
      anon_sym_group,
      anon_sym_oneof,
      anon_sym_map,
      anon_sym_int32,
      anon_sym_int64,
      anon_sym_uint32,
      anon_sym_uint64,
      anon_sym_sint32,
      anon_sym_sint64,
      anon_sym_fixed32,
      anon_sym_fixed64,
      anon_sym_sfixed32,
      anon_sym_sfixed64,
      anon_sym_bool,
      anon_sym_string,
      anon_sym_double,
      anon_sym_float,
      anon_sym_bytes,
      anon_sym_reserved,
      anon_sym_extensions,
      sym_identifier,
  [552] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(127), 3,
      anon_sym_SEMI,
      anon_sym_DOT,
      anon_sym_RBRACE,
    ACTIONS(129), 30,
      anon_sym_option,
      anon_sym_export,
      anon_sym_local,
      anon_sym_enum,
      anon_sym_message,
      anon_sym_extend,
      anon_sym_optional,
      anon_sym_required,
      anon_sym_repeated,
      anon_sym_group,
      anon_sym_oneof,
      anon_sym_map,
      anon_sym_int32,
      anon_sym_int64,
      anon_sym_uint32,
      anon_sym_uint64,
      anon_sym_sint32,
      anon_sym_sint64,
      anon_sym_fixed32,
      anon_sym_fixed64,
      anon_sym_sfixed32,
      anon_sym_sfixed64,
      anon_sym_bool,
      anon_sym_string,
      anon_sym_double,
      anon_sym_float,
      anon_sym_bytes,
      anon_sym_reserved,
      anon_sym_extensions,
      sym_identifier,
  [593] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(131), 3,
      anon_sym_SEMI,
      anon_sym_DOT,
      anon_sym_RBRACE,
    ACTIONS(133), 30,
      anon_sym_option,
      anon_sym_export,
      anon_sym_local,
      anon_sym_enum,
      anon_sym_message,
      anon_sym_extend,
      anon_sym_optional,
      anon_sym_required,
      anon_sym_repeated,
      anon_sym_group,
      anon_sym_oneof,
      anon_sym_map,
      anon_sym_int32,
      anon_sym_int64,
      anon_sym_uint32,
      anon_sym_uint64,
      anon_sym_sint32,
      anon_sym_sint64,
      anon_sym_fixed32,
      anon_sym_fixed64,
      anon_sym_sfixed32,
      anon_sym_sfixed64,
      anon_sym_bool,
      anon_sym_string,
      anon_sym_double,
      anon_sym_float,
      anon_sym_bytes,
      anon_sym_reserved,
      anon_sym_extensions,
      sym_identifier,
  [634] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(135), 3,
      anon_sym_SEMI,
      anon_sym_DOT,
      anon_sym_RBRACE,
    ACTIONS(137), 30,
      anon_sym_option,
      anon_sym_export,
      anon_sym_local,
      anon_sym_enum,
      anon_sym_message,
      anon_sym_extend,
      anon_sym_optional,
      anon_sym_required,
      anon_sym_repeated,
      anon_sym_group,
      anon_sym_oneof,
      anon_sym_map,
      anon_sym_int32,
      anon_sym_int64,
      anon_sym_uint32,
      anon_sym_uint64,
      anon_sym_sint32,
      anon_sym_sint64,
      anon_sym_fixed32,
      anon_sym_fixed64,
      anon_sym_sfixed32,
      anon_sym_sfixed64,
      anon_sym_bool,
      anon_sym_string,
      anon_sym_double,
      anon_sym_float,
      anon_sym_bytes,
      anon_sym_reserved,
      anon_sym_extensions,
      sym_identifier,
  [675] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(139), 3,
      anon_sym_SEMI,
      anon_sym_DOT,
      anon_sym_RBRACE,
    ACTIONS(141), 30,
      anon_sym_option,
      anon_sym_export,
      anon_sym_local,
      anon_sym_enum,
      anon_sym_message,
      anon_sym_extend,
      anon_sym_optional,
      anon_sym_required,
      anon_sym_repeated,
      anon_sym_group,
      anon_sym_oneof,
      anon_sym_map,
      anon_sym_int32,
      anon_sym_int64,
      anon_sym_uint32,
      anon_sym_uint64,
      anon_sym_sint32,
      anon_sym_sint64,
      anon_sym_fixed32,
      anon_sym_fixed64,
      anon_sym_sfixed32,
      anon_sym_sfixed64,
      anon_sym_bool,
      anon_sym_string,
      anon_sym_double,
      anon_sym_float,
      anon_sym_bytes,
      anon_sym_reserved,
      anon_sym_extensions,
      sym_identifier,
  [716] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(143), 3,
      anon_sym_SEMI,
      anon_sym_DOT,
      anon_sym_RBRACE,
    ACTIONS(145), 30,
      anon_sym_option,
      anon_sym_export,
      anon_sym_local,
      anon_sym_enum,
      anon_sym_message,
      anon_sym_extend,
      anon_sym_optional,
      anon_sym_required,
      anon_sym_repeated,
      anon_sym_group,
      anon_sym_oneof,
      anon_sym_map,
      anon_sym_int32,
      anon_sym_int64,
      anon_sym_uint32,
      anon_sym_uint64,
      anon_sym_sint32,
      anon_sym_sint64,
      anon_sym_fixed32,
      anon_sym_fixed64,
      anon_sym_sfixed32,
      anon_sym_sfixed64,
      anon_sym_bool,
      anon_sym_string,
      anon_sym_double,
      anon_sym_float,
      anon_sym_bytes,
      anon_sym_reserved,
      anon_sym_extensions,
      sym_identifier,
  [757] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(147), 3,
      anon_sym_SEMI,
      anon_sym_DOT,
      anon_sym_RBRACE,
    ACTIONS(149), 30,
      anon_sym_option,
      anon_sym_export,
      anon_sym_local,
      anon_sym_enum,
      anon_sym_message,
      anon_sym_extend,
      anon_sym_optional,
      anon_sym_required,
      anon_sym_repeated,
      anon_sym_group,
      anon_sym_oneof,
      anon_sym_map,
      anon_sym_int32,
      anon_sym_int64,
      anon_sym_uint32,
      anon_sym_uint64,
      anon_sym_sint32,
      anon_sym_sint64,
      anon_sym_fixed32,
      anon_sym_fixed64,
      anon_sym_sfixed32,
      anon_sym_sfixed64,
      anon_sym_bool,
      anon_sym_string,
      anon_sym_double,
      anon_sym_float,
      anon_sym_bytes,
      anon_sym_reserved,
      anon_sym_extensions,
      sym_identifier,
  [798] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(151), 3,
      anon_sym_SEMI,
      anon_sym_DOT,
      anon_sym_RBRACE,
    ACTIONS(153), 30,
      anon_sym_option,
      anon_sym_export,
      anon_sym_local,
      anon_sym_enum,
      anon_sym_message,
      anon_sym_extend,
      anon_sym_optional,
      anon_sym_required,
      anon_sym_repeated,
      anon_sym_group,
      anon_sym_oneof,
      anon_sym_map,
      anon_sym_int32,
      anon_sym_int64,
      anon_sym_uint32,
      anon_sym_uint64,
      anon_sym_sint32,
      anon_sym_sint64,
      anon_sym_fixed32,
      anon_sym_fixed64,
      anon_sym_sfixed32,
      anon_sym_sfixed64,
      anon_sym_bool,
      anon_sym_string,
      anon_sym_double,
      anon_sym_float,
      anon_sym_bytes,
      anon_sym_reserved,
      anon_sym_extensions,
      sym_identifier,
  [839] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(155), 3,
      anon_sym_SEMI,
      anon_sym_DOT,
      anon_sym_RBRACE,
    ACTIONS(157), 30,
      anon_sym_option,
      anon_sym_export,
      anon_sym_local,
      anon_sym_enum,
      anon_sym_message,
      anon_sym_extend,
      anon_sym_optional,
      anon_sym_required,
      anon_sym_repeated,
      anon_sym_group,
      anon_sym_oneof,
      anon_sym_map,
      anon_sym_int32,
      anon_sym_int64,
      anon_sym_uint32,
      anon_sym_uint64,
      anon_sym_sint32,
      anon_sym_sint64,
      anon_sym_fixed32,
      anon_sym_fixed64,
      anon_sym_sfixed32,
      anon_sym_sfixed64,
      anon_sym_bool,
      anon_sym_string,
      anon_sym_double,
      anon_sym_float,
      anon_sym_bytes,
      anon_sym_reserved,
      anon_sym_extensions,
      sym_identifier,
  [880] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(159), 3,
      anon_sym_SEMI,
      anon_sym_DOT,
      anon_sym_RBRACE,
    ACTIONS(161), 30,
      anon_sym_option,
      anon_sym_export,
      anon_sym_local,
      anon_sym_enum,
      anon_sym_message,
      anon_sym_extend,
      anon_sym_optional,
      anon_sym_required,
      anon_sym_repeated,
      anon_sym_group,
      anon_sym_oneof,
      anon_sym_map,
      anon_sym_int32,
      anon_sym_int64,
      anon_sym_uint32,
      anon_sym_uint64,
      anon_sym_sint32,
      anon_sym_sint64,
      anon_sym_fixed32,
      anon_sym_fixed64,
      anon_sym_sfixed32,
      anon_sym_sfixed64,
      anon_sym_bool,
      anon_sym_string,
      anon_sym_double,
      anon_sym_float,
      anon_sym_bytes,
      anon_sym_reserved,
      anon_sym_extensions,
      sym_identifier,
  [921] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(163), 3,
      anon_sym_SEMI,
      anon_sym_DOT,
      anon_sym_RBRACE,
    ACTIONS(165), 30,
      anon_sym_option,
      anon_sym_export,
      anon_sym_local,
      anon_sym_enum,
      anon_sym_message,
      anon_sym_extend,
      anon_sym_optional,
      anon_sym_required,
      anon_sym_repeated,
      anon_sym_group,
      anon_sym_oneof,
      anon_sym_map,
      anon_sym_int32,
      anon_sym_int64,
      anon_sym_uint32,
      anon_sym_uint64,
      anon_sym_sint32,
      anon_sym_sint64,
      anon_sym_fixed32,
      anon_sym_fixed64,
      anon_sym_sfixed32,
      anon_sym_sfixed64,
      anon_sym_bool,
      anon_sym_string,
      anon_sym_double,
      anon_sym_float,
      anon_sym_bytes,
      anon_sym_reserved,
      anon_sym_extensions,
      sym_identifier,
  [962] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(167), 3,
      anon_sym_SEMI,
      anon_sym_DOT,
      anon_sym_RBRACE,
    ACTIONS(169), 30,
      anon_sym_option,
      anon_sym_export,
      anon_sym_local,
      anon_sym_enum,
      anon_sym_message,
      anon_sym_extend,
      anon_sym_optional,
      anon_sym_required,
      anon_sym_repeated,
      anon_sym_group,
      anon_sym_oneof,
      anon_sym_map,
      anon_sym_int32,
      anon_sym_int64,
      anon_sym_uint32,
      anon_sym_uint64,
      anon_sym_sint32,
      anon_sym_sint64,
      anon_sym_fixed32,
      anon_sym_fixed64,
      anon_sym_sfixed32,
      anon_sym_sfixed64,
      anon_sym_bool,
      anon_sym_string,
      anon_sym_double,
      anon_sym_float,
      anon_sym_bytes,
      anon_sym_reserved,
      anon_sym_extensions,
      sym_identifier,
  [1003] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(171), 3,
      anon_sym_SEMI,
      anon_sym_DOT,
      anon_sym_RBRACE,
    ACTIONS(173), 30,
      anon_sym_option,
      anon_sym_export,
      anon_sym_local,
      anon_sym_enum,
      anon_sym_message,
      anon_sym_extend,
      anon_sym_optional,
      anon_sym_required,
      anon_sym_repeated,
      anon_sym_group,
      anon_sym_oneof,
      anon_sym_map,
      anon_sym_int32,
      anon_sym_int64,
      anon_sym_uint32,
      anon_sym_uint64,
      anon_sym_sint32,
      anon_sym_sint64,
      anon_sym_fixed32,
      anon_sym_fixed64,
      anon_sym_sfixed32,
      anon_sym_sfixed64,
      anon_sym_bool,
      anon_sym_string,
      anon_sym_double,
      anon_sym_float,
      anon_sym_bytes,
      anon_sym_reserved,
      anon_sym_extensions,
      sym_identifier,
  [1044] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(175), 3,
      anon_sym_SEMI,
      anon_sym_DOT,
      anon_sym_RBRACE,
    ACTIONS(177), 30,
      anon_sym_option,
      anon_sym_export,
      anon_sym_local,
      anon_sym_enum,
      anon_sym_message,
      anon_sym_extend,
      anon_sym_optional,
      anon_sym_required,
      anon_sym_repeated,
      anon_sym_group,
      anon_sym_oneof,
      anon_sym_map,
      anon_sym_int32,
      anon_sym_int64,
      anon_sym_uint32,
      anon_sym_uint64,
      anon_sym_sint32,
      anon_sym_sint64,
      anon_sym_fixed32,
      anon_sym_fixed64,
      anon_sym_sfixed32,
      anon_sym_sfixed64,
      anon_sym_bool,
      anon_sym_string,
      anon_sym_double,
      anon_sym_float,
      anon_sym_bytes,
      anon_sym_reserved,
      anon_sym_extensions,
      sym_identifier,
  [1085] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(179), 3,
      anon_sym_SEMI,
      anon_sym_DOT,
      anon_sym_RBRACE,
    ACTIONS(181), 30,
      anon_sym_option,
      anon_sym_export,
      anon_sym_local,
      anon_sym_enum,
      anon_sym_message,
      anon_sym_extend,
      anon_sym_optional,
      anon_sym_required,
      anon_sym_repeated,
      anon_sym_group,
      anon_sym_oneof,
      anon_sym_map,
      anon_sym_int32,
      anon_sym_int64,
      anon_sym_uint32,
      anon_sym_uint64,
      anon_sym_sint32,
      anon_sym_sint64,
      anon_sym_fixed32,
      anon_sym_fixed64,
      anon_sym_sfixed32,
      anon_sym_sfixed64,
      anon_sym_bool,
      anon_sym_string,
      anon_sym_double,
      anon_sym_float,
      anon_sym_bytes,
      anon_sym_reserved,
      anon_sym_extensions,
      sym_identifier,
  [1126] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(183), 3,
      anon_sym_SEMI,
      anon_sym_DOT,
      anon_sym_RBRACE,
    ACTIONS(185), 30,
      anon_sym_option,
      anon_sym_export,
      anon_sym_local,
      anon_sym_enum,
      anon_sym_message,
      anon_sym_extend,
      anon_sym_optional,
      anon_sym_required,
      anon_sym_repeated,
      anon_sym_group,
      anon_sym_oneof,
      anon_sym_map,
      anon_sym_int32,
      anon_sym_int64,
      anon_sym_uint32,
      anon_sym_uint64,
      anon_sym_sint32,
      anon_sym_sint64,
      anon_sym_fixed32,
      anon_sym_fixed64,
      anon_sym_sfixed32,
      anon_sym_sfixed64,
      anon_sym_bool,
      anon_sym_string,
      anon_sym_double,
      anon_sym_float,
      anon_sym_bytes,
      anon_sym_reserved,
      anon_sym_extensions,
      sym_identifier,
  [1167] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(187), 3,
      anon_sym_SEMI,
      anon_sym_DOT,
      anon_sym_RBRACE,
    ACTIONS(189), 30,
      anon_sym_option,
      anon_sym_export,
      anon_sym_local,
      anon_sym_enum,
      anon_sym_message,
      anon_sym_extend,
      anon_sym_optional,
      anon_sym_required,
      anon_sym_repeated,
      anon_sym_group,
      anon_sym_oneof,
      anon_sym_map,
      anon_sym_int32,
      anon_sym_int64,
      anon_sym_uint32,
      anon_sym_uint64,
      anon_sym_sint32,
      anon_sym_sint64,
      anon_sym_fixed32,
      anon_sym_fixed64,
      anon_sym_sfixed32,
      anon_sym_sfixed64,
      anon_sym_bool,
      anon_sym_string,
      anon_sym_double,
      anon_sym_float,
      anon_sym_bytes,
      anon_sym_reserved,
      anon_sym_extensions,
      sym_identifier,
  [1208] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(191), 3,
      anon_sym_SEMI,
      anon_sym_DOT,
      anon_sym_RBRACE,
    ACTIONS(193), 30,
      anon_sym_option,
      anon_sym_export,
      anon_sym_local,
      anon_sym_enum,
      anon_sym_message,
      anon_sym_extend,
      anon_sym_optional,
      anon_sym_required,
      anon_sym_repeated,
      anon_sym_group,
      anon_sym_oneof,
      anon_sym_map,
      anon_sym_int32,
      anon_sym_int64,
      anon_sym_uint32,
      anon_sym_uint64,
      anon_sym_sint32,
      anon_sym_sint64,
      anon_sym_fixed32,
      anon_sym_fixed64,
      anon_sym_sfixed32,
      anon_sym_sfixed64,
      anon_sym_bool,
      anon_sym_string,
      anon_sym_double,
      anon_sym_float,
      anon_sym_bytes,
      anon_sym_reserved,
      anon_sym_extensions,
      sym_identifier,
  [1249] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(195), 3,
      anon_sym_SEMI,
      anon_sym_DOT,
      anon_sym_RBRACE,
    ACTIONS(197), 30,
      anon_sym_option,
      anon_sym_export,
      anon_sym_local,
      anon_sym_enum,
      anon_sym_message,
      anon_sym_extend,
      anon_sym_optional,
      anon_sym_required,
      anon_sym_repeated,
      anon_sym_group,
      anon_sym_oneof,
      anon_sym_map,
      anon_sym_int32,
      anon_sym_int64,
      anon_sym_uint32,
      anon_sym_uint64,
      anon_sym_sint32,
      anon_sym_sint64,
      anon_sym_fixed32,
      anon_sym_fixed64,
      anon_sym_sfixed32,
      anon_sym_sfixed64,
      anon_sym_bool,
      anon_sym_string,
      anon_sym_double,
      anon_sym_float,
      anon_sym_bytes,
      anon_sym_reserved,
      anon_sym_extensions,
      sym_identifier,
  [1290] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(199), 3,
      anon_sym_SEMI,
      anon_sym_DOT,
      anon_sym_RBRACE,
    ACTIONS(201), 30,
      anon_sym_option,
      anon_sym_export,
      anon_sym_local,
      anon_sym_enum,
      anon_sym_message,
      anon_sym_extend,
      anon_sym_optional,
      anon_sym_required,
      anon_sym_repeated,
      anon_sym_group,
      anon_sym_oneof,
      anon_sym_map,
      anon_sym_int32,
      anon_sym_int64,
      anon_sym_uint32,
      anon_sym_uint64,
      anon_sym_sint32,
      anon_sym_sint64,
      anon_sym_fixed32,
      anon_sym_fixed64,
      anon_sym_sfixed32,
      anon_sym_sfixed64,
      anon_sym_bool,
      anon_sym_string,
      anon_sym_double,
      anon_sym_float,
      anon_sym_bytes,
      anon_sym_reserved,
      anon_sym_extensions,
      sym_identifier,
  [1331] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(203), 3,
      anon_sym_SEMI,
      anon_sym_DOT,
      anon_sym_RBRACE,
    ACTIONS(205), 30,
      anon_sym_option,
      anon_sym_export,
      anon_sym_local,
      anon_sym_enum,
      anon_sym_message,
      anon_sym_extend,
      anon_sym_optional,
      anon_sym_required,
      anon_sym_repeated,
      anon_sym_group,
      anon_sym_oneof,
      anon_sym_map,
      anon_sym_int32,
      anon_sym_int64,
      anon_sym_uint32,
      anon_sym_uint64,
      anon_sym_sint32,
      anon_sym_sint64,
      anon_sym_fixed32,
      anon_sym_fixed64,
      anon_sym_sfixed32,
      anon_sym_sfixed64,
      anon_sym_bool,
      anon_sym_string,
      anon_sym_double,
      anon_sym_float,
      anon_sym_bytes,
      anon_sym_reserved,
      anon_sym_extensions,
      sym_identifier,
  [1372] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(207), 3,
      anon_sym_SEMI,
      anon_sym_DOT,
      anon_sym_RBRACE,
    ACTIONS(209), 30,
      anon_sym_option,
      anon_sym_export,
      anon_sym_local,
      anon_sym_enum,
      anon_sym_message,
      anon_sym_extend,
      anon_sym_optional,
      anon_sym_required,
      anon_sym_repeated,
      anon_sym_group,
      anon_sym_oneof,
      anon_sym_map,
      anon_sym_int32,
      anon_sym_int64,
      anon_sym_uint32,
      anon_sym_uint64,
      anon_sym_sint32,
      anon_sym_sint64,
      anon_sym_fixed32,
      anon_sym_fixed64,
      anon_sym_sfixed32,
      anon_sym_sfixed64,
      anon_sym_bool,
      anon_sym_string,
      anon_sym_double,
      anon_sym_float,
      anon_sym_bytes,
      anon_sym_reserved,
      anon_sym_extensions,
      sym_identifier,
  [1413] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(211), 3,
      anon_sym_SEMI,
      anon_sym_DOT,
      anon_sym_RBRACE,
    ACTIONS(213), 30,
      anon_sym_option,
      anon_sym_export,
      anon_sym_local,
      anon_sym_enum,
      anon_sym_message,
      anon_sym_extend,
      anon_sym_optional,
      anon_sym_required,
      anon_sym_repeated,
      anon_sym_group,
      anon_sym_oneof,
      anon_sym_map,
      anon_sym_int32,
      anon_sym_int64,
      anon_sym_uint32,
      anon_sym_uint64,
      anon_sym_sint32,
      anon_sym_sint64,
      anon_sym_fixed32,
      anon_sym_fixed64,
      anon_sym_sfixed32,
      anon_sym_sfixed64,
      anon_sym_bool,
      anon_sym_string,
      anon_sym_double,
      anon_sym_float,
      anon_sym_bytes,
      anon_sym_reserved,
      anon_sym_extensions,
      sym_identifier,
  [1454] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(215), 3,
      anon_sym_SEMI,
      anon_sym_DOT,
      anon_sym_RBRACE,
    ACTIONS(217), 30,
      anon_sym_option,
      anon_sym_export,
      anon_sym_local,
      anon_sym_enum,
      anon_sym_message,
      anon_sym_extend,
      anon_sym_optional,
      anon_sym_required,
      anon_sym_repeated,
      anon_sym_group,
      anon_sym_oneof,
      anon_sym_map,
      anon_sym_int32,
      anon_sym_int64,
      anon_sym_uint32,
      anon_sym_uint64,
      anon_sym_sint32,
      anon_sym_sint64,
      anon_sym_fixed32,
      anon_sym_fixed64,
      anon_sym_sfixed32,
      anon_sym_sfixed64,
      anon_sym_bool,
      anon_sym_string,
      anon_sym_double,
      anon_sym_float,
      anon_sym_bytes,
      anon_sym_reserved,
      anon_sym_extensions,
      sym_identifier,
  [1495] = 11,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(33), 1,
      anon_sym_DOT,
    ACTIONS(61), 1,
      sym_identifier,
    ACTIONS(219), 1,
      anon_sym_SEMI,
    ACTIONS(221), 1,
      anon_sym_option,
    ACTIONS(223), 1,
      anon_sym_RBRACE,
    STATE(241), 1,
      sym_message_or_enum_type,
    STATE(271), 1,
      aux_sym_message_or_enum_type_repeat1,
    STATE(342), 1,
      sym_type,
    STATE(34), 4,
      sym_empty_statement,
      sym_option,
      sym_oneof_field,
      aux_sym_oneof_repeat1,
    ACTIONS(55), 15,
      anon_sym_int32,
      anon_sym_int64,
      anon_sym_uint32,
      anon_sym_uint64,
      anon_sym_sint32,
      anon_sym_sint64,
      anon_sym_fixed32,
      anon_sym_fixed64,
      anon_sym_sfixed32,
      anon_sym_sfixed64,
      anon_sym_bool,
      anon_sym_string,
      anon_sym_double,
      anon_sym_float,
      anon_sym_bytes,
  [1546] = 11,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(225), 1,
      anon_sym_SEMI,
    ACTIONS(228), 1,
      anon_sym_option,
    ACTIONS(231), 1,
      anon_sym_DOT,
    ACTIONS(234), 1,
      anon_sym_RBRACE,
    ACTIONS(239), 1,
      sym_identifier,
    STATE(241), 1,
      sym_message_or_enum_type,
    STATE(271), 1,
      aux_sym_message_or_enum_type_repeat1,
    STATE(342), 1,
      sym_type,
    STATE(33), 4,
      sym_empty_statement,
      sym_option,
      sym_oneof_field,
      aux_sym_oneof_repeat1,
    ACTIONS(236), 15,
      anon_sym_int32,
      anon_sym_int64,
      anon_sym_uint32,
      anon_sym_uint64,
      anon_sym_sint32,
      anon_sym_sint64,
      anon_sym_fixed32,
      anon_sym_fixed64,
      anon_sym_sfixed32,
      anon_sym_sfixed64,
      anon_sym_bool,
      anon_sym_string,
      anon_sym_double,
      anon_sym_float,
      anon_sym_bytes,
  [1597] = 11,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(33), 1,
      anon_sym_DOT,
    ACTIONS(61), 1,
      sym_identifier,
    ACTIONS(219), 1,
      anon_sym_SEMI,
    ACTIONS(221), 1,
      anon_sym_option,
    ACTIONS(242), 1,
      anon_sym_RBRACE,
    STATE(241), 1,
      sym_message_or_enum_type,
    STATE(271), 1,
      aux_sym_message_or_enum_type_repeat1,
    STATE(342), 1,
      sym_type,
    STATE(33), 4,
      sym_empty_statement,
      sym_option,
      sym_oneof_field,
      aux_sym_oneof_repeat1,
    ACTIONS(55), 15,
      anon_sym_int32,
      anon_sym_int64,
      anon_sym_uint32,
      anon_sym_uint64,
      anon_sym_sint32,
      anon_sym_sint64,
      anon_sym_fixed32,
      anon_sym_fixed64,
      anon_sym_sfixed32,
      anon_sym_sfixed64,
      anon_sym_bool,
      anon_sym_string,
      anon_sym_double,
      anon_sym_float,
      anon_sym_bytes,
  [1648] = 9,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(33), 1,
      anon_sym_DOT,
    ACTIONS(61), 1,
      sym_identifier,
    ACTIONS(244), 1,
      anon_sym_repeated,
    ACTIONS(246), 1,
      anon_sym_group,
    STATE(241), 1,
      sym_message_or_enum_type,
    STATE(271), 1,
      aux_sym_message_or_enum_type_repeat1,
    STATE(276), 1,
      sym_type,
    ACTIONS(55), 15,
      anon_sym_int32,
      anon_sym_int64,
      anon_sym_uint32,
      anon_sym_uint64,
      anon_sym_sint32,
      anon_sym_sint64,
      anon_sym_fixed32,
      anon_sym_fixed64,
      anon_sym_sfixed32,
      anon_sym_sfixed64,
      anon_sym_bool,
      anon_sym_string,
      anon_sym_double,
      anon_sym_float,
      anon_sym_bytes,
  [1690] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(248), 5,
      anon_sym_SEMI,
      anon_sym_DOT,
      anon_sym_LBRACE,
      anon_sym_RBRACE,
      anon_sym_LBRACK,
    ACTIONS(250), 17,
      anon_sym_option,
      anon_sym_int32,
      anon_sym_int64,
      anon_sym_uint32,
      anon_sym_uint64,
      anon_sym_sint32,
      anon_sym_sint64,
      anon_sym_fixed32,
      anon_sym_fixed64,
      anon_sym_sfixed32,
      anon_sym_sfixed64,
      anon_sym_bool,
      anon_sym_string,
      anon_sym_double,
      anon_sym_float,
      anon_sym_bytes,
      sym_identifier,
  [1720] = 4,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(256), 1,
      anon_sym_LBRACK,
    ACTIONS(252), 3,
      anon_sym_SEMI,
      anon_sym_DOT,
      anon_sym_RBRACE,
    ACTIONS(254), 17,
      anon_sym_option,
      anon_sym_int32,
      anon_sym_int64,
      anon_sym_uint32,
      anon_sym_uint64,
      anon_sym_sint32,
      anon_sym_sint64,
      anon_sym_fixed32,
      anon_sym_fixed64,
      anon_sym_sfixed32,
      anon_sym_sfixed64,
      anon_sym_bool,
      anon_sym_string,
      anon_sym_double,
      anon_sym_float,
      anon_sym_bytes,
      sym_identifier,
  [1751] = 8,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(33), 1,
      anon_sym_DOT,
    ACTIONS(61), 1,
      sym_identifier,
    ACTIONS(246), 1,
      anon_sym_group,
    STATE(241), 1,
      sym_message_or_enum_type,
    STATE(271), 1,
      aux_sym_message_or_enum_type_repeat1,
    STATE(276), 1,
      sym_type,
    ACTIONS(55), 15,
      anon_sym_int32,
      anon_sym_int64,
      anon_sym_uint32,
      anon_sym_uint64,
      anon_sym_sint32,
      anon_sym_sint64,
      anon_sym_fixed32,
      anon_sym_fixed64,
      anon_sym_sfixed32,
      anon_sym_sfixed64,
      anon_sym_bool,
      anon_sym_string,
      anon_sym_double,
      anon_sym_float,
      anon_sym_bytes,
  [1790] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(258), 4,
      anon_sym_SEMI,
      anon_sym_DOT,
      anon_sym_RBRACE,
      anon_sym_LBRACK,
    ACTIONS(260), 17,
      anon_sym_option,
      anon_sym_int32,
      anon_sym_int64,
      anon_sym_uint32,
      anon_sym_uint64,
      anon_sym_sint32,
      anon_sym_sint64,
      anon_sym_fixed32,
      anon_sym_fixed64,
      anon_sym_sfixed32,
      anon_sym_sfixed64,
      anon_sym_bool,
      anon_sym_string,
      anon_sym_double,
      anon_sym_float,
      anon_sym_bytes,
      sym_identifier,
  [1819] = 15,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(262), 1,
      anon_sym_LBRACE,
    ACTIONS(266), 1,
      anon_sym_LBRACK,
    ACTIONS(268), 1,
      anon_sym_COLON,
    ACTIONS(270), 1,
      sym_identifier,
    ACTIONS(276), 1,
      sym_hex_lit,
    ACTIONS(278), 1,
      sym_float_lit,
    ACTIONS(280), 1,
      anon_sym_DQUOTE,
    ACTIONS(282), 1,
      anon_sym_SQUOTE,
    STATE(93), 1,
      aux_sym_string_repeat3,
    STATE(127), 1,
      sym_constant,
    ACTIONS(264), 2,
      anon_sym_DASH,
      anon_sym_PLUS,
    ACTIONS(272), 2,
      sym_true,
      sym_false,
    ACTIONS(274), 2,
      sym_decimal_lit,
      sym_octal_lit,
    STATE(112), 5,
      sym_block_lit,
      sym_full_ident,
      sym_bool,
      sym_int_lit,
      sym_string,
  [1872] = 15,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(262), 1,
      anon_sym_LBRACE,
    ACTIONS(270), 1,
      sym_identifier,
    ACTIONS(276), 1,
      sym_hex_lit,
    ACTIONS(278), 1,
      sym_float_lit,
    ACTIONS(280), 1,
      anon_sym_DQUOTE,
    ACTIONS(282), 1,
      anon_sym_SQUOTE,
    ACTIONS(284), 1,
      anon_sym_LBRACK,
    ACTIONS(286), 1,
      anon_sym_COLON,
    STATE(93), 1,
      aux_sym_string_repeat3,
    STATE(142), 1,
      sym_constant,
    ACTIONS(264), 2,
      anon_sym_DASH,
      anon_sym_PLUS,
    ACTIONS(272), 2,
      sym_true,
      sym_false,
    ACTIONS(274), 2,
      sym_decimal_lit,
      sym_octal_lit,
    STATE(112), 5,
      sym_block_lit,
      sym_full_ident,
      sym_bool,
      sym_int_lit,
      sym_string,
  [1925] = 12,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(7), 1,
      anon_sym_SEMI,
    ACTIONS(13), 1,
      anon_sym_import,
    ACTIONS(15), 1,
      anon_sym_option,
    ACTIONS(17), 1,
      anon_sym_package,
    ACTIONS(21), 1,
      anon_sym_enum,
    ACTIONS(23), 1,
      anon_sym_message,
    ACTIONS(25), 1,
      anon_sym_extend,
    ACTIONS(27), 1,
      anon_sym_service,
    ACTIONS(288), 1,
      ts_builtin_sym_end,
    ACTIONS(19), 2,
      anon_sym_export,
      anon_sym_local,
    STATE(45), 9,
      sym_empty_statement,
      sym_import,
      sym_package,
      sym_option,
      sym_enum,
      sym_message,
      sym_extend,
      sym_service,
      aux_sym_source_file_repeat1,
  [1971] = 7,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(33), 1,
      anon_sym_DOT,
    ACTIONS(61), 1,
      sym_identifier,
    STATE(241), 1,
      sym_message_or_enum_type,
    STATE(271), 1,
      aux_sym_message_or_enum_type_repeat1,
    STATE(320), 1,
      sym_type,
    ACTIONS(55), 15,
      anon_sym_int32,
      anon_sym_int64,
      anon_sym_uint32,
      anon_sym_uint64,
      anon_sym_sint32,
      anon_sym_sint64,
      anon_sym_fixed32,
      anon_sym_fixed64,
      anon_sym_sfixed32,
      anon_sym_sfixed64,
      anon_sym_bool,
      anon_sym_string,
      anon_sym_double,
      anon_sym_float,
      anon_sym_bytes,
  [2007] = 12,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(7), 1,
      anon_sym_SEMI,
    ACTIONS(13), 1,
      anon_sym_import,
    ACTIONS(15), 1,
      anon_sym_option,
    ACTIONS(17), 1,
      anon_sym_package,
    ACTIONS(21), 1,
      anon_sym_enum,
    ACTIONS(23), 1,
      anon_sym_message,
    ACTIONS(25), 1,
      anon_sym_extend,
    ACTIONS(27), 1,
      anon_sym_service,
    ACTIONS(290), 1,
      ts_builtin_sym_end,
    ACTIONS(19), 2,
      anon_sym_export,
      anon_sym_local,
    STATE(42), 9,
      sym_empty_statement,
      sym_import,
      sym_package,
      sym_option,
      sym_enum,
      sym_message,
      sym_extend,
      sym_service,
      aux_sym_source_file_repeat1,
  [2053] = 12,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(292), 1,
      ts_builtin_sym_end,
    ACTIONS(294), 1,
      anon_sym_SEMI,
    ACTIONS(297), 1,
      anon_sym_import,
    ACTIONS(300), 1,
      anon_sym_option,
    ACTIONS(303), 1,
      anon_sym_package,
    ACTIONS(309), 1,
      anon_sym_enum,
    ACTIONS(312), 1,
      anon_sym_message,
    ACTIONS(315), 1,
      anon_sym_extend,
    ACTIONS(318), 1,
      anon_sym_service,
    ACTIONS(306), 2,
      anon_sym_export,
      anon_sym_local,
    STATE(45), 9,
      sym_empty_statement,
      sym_import,
      sym_package,
      sym_option,
      sym_enum,
      sym_message,
      sym_extend,
      sym_service,
      aux_sym_source_file_repeat1,
  [2099] = 14,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(262), 1,
      anon_sym_LBRACE,
    ACTIONS(270), 1,
      sym_identifier,
    ACTIONS(278), 1,
      sym_float_lit,
    ACTIONS(280), 1,
      anon_sym_DQUOTE,
    ACTIONS(282), 1,
      anon_sym_SQUOTE,
    ACTIONS(323), 1,
      anon_sym_RBRACK,
    ACTIONS(327), 1,
      sym_hex_lit,
    STATE(93), 1,
      aux_sym_string_repeat3,
    STATE(202), 1,
      sym_constant,
    ACTIONS(272), 2,
      sym_true,
      sym_false,
    ACTIONS(321), 2,
      anon_sym_DASH,
      anon_sym_PLUS,
    ACTIONS(325), 2,
      sym_decimal_lit,
      sym_octal_lit,
    STATE(112), 5,
      sym_block_lit,
      sym_full_ident,
      sym_bool,
      sym_int_lit,
      sym_string,
  [2149] = 14,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(262), 1,
      anon_sym_LBRACE,
    ACTIONS(270), 1,
      sym_identifier,
    ACTIONS(278), 1,
      sym_float_lit,
    ACTIONS(280), 1,
      anon_sym_DQUOTE,
    ACTIONS(282), 1,
      anon_sym_SQUOTE,
    ACTIONS(327), 1,
      sym_hex_lit,
    ACTIONS(329), 1,
      anon_sym_RBRACK,
    STATE(93), 1,
      aux_sym_string_repeat3,
    STATE(183), 1,
      sym_constant,
    ACTIONS(272), 2,
      sym_true,
      sym_false,
    ACTIONS(321), 2,
      anon_sym_DASH,
      anon_sym_PLUS,
    ACTIONS(325), 2,
      sym_decimal_lit,
      sym_octal_lit,
    STATE(112), 5,
      sym_block_lit,
      sym_full_ident,
      sym_bool,
      sym_int_lit,
      sym_string,
  [2199] = 14,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(262), 1,
      anon_sym_LBRACE,
    ACTIONS(270), 1,
      sym_identifier,
    ACTIONS(276), 1,
      sym_hex_lit,
    ACTIONS(278), 1,
      sym_float_lit,
    ACTIONS(280), 1,
      anon_sym_DQUOTE,
    ACTIONS(282), 1,
      anon_sym_SQUOTE,
    ACTIONS(331), 1,
      anon_sym_LBRACK,
    STATE(93), 1,
      aux_sym_string_repeat3,
    STATE(141), 1,
      sym_constant,
    ACTIONS(264), 2,
      anon_sym_DASH,
      anon_sym_PLUS,
    ACTIONS(272), 2,
      sym_true,
      sym_false,
    ACTIONS(274), 2,
      sym_decimal_lit,
      sym_octal_lit,
    STATE(112), 5,
      sym_block_lit,
      sym_full_ident,
      sym_bool,
      sym_int_lit,
      sym_string,
  [2249] = 7,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(33), 1,
      anon_sym_DOT,
    ACTIONS(61), 1,
      sym_identifier,
    STATE(241), 1,
      sym_message_or_enum_type,
    STATE(271), 1,
      aux_sym_message_or_enum_type_repeat1,
    STATE(274), 1,
      sym_type,
    ACTIONS(55), 15,
      anon_sym_int32,
      anon_sym_int64,
      anon_sym_uint32,
      anon_sym_uint64,
      anon_sym_sint32,
      anon_sym_sint64,
      anon_sym_fixed32,
      anon_sym_fixed64,
      anon_sym_sfixed32,
      anon_sym_sfixed64,
      anon_sym_bool,
      anon_sym_string,
      anon_sym_double,
      anon_sym_float,
      anon_sym_bytes,
  [2285] = 14,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(262), 1,
      anon_sym_LBRACE,
    ACTIONS(270), 1,
      sym_identifier,
    ACTIONS(278), 1,
      sym_float_lit,
    ACTIONS(280), 1,
      anon_sym_DQUOTE,
    ACTIONS(282), 1,
      anon_sym_SQUOTE,
    ACTIONS(327), 1,
      sym_hex_lit,
    ACTIONS(333), 1,
      anon_sym_RBRACK,
    STATE(93), 1,
      aux_sym_string_repeat3,
    STATE(197), 1,
      sym_constant,
    ACTIONS(272), 2,
      sym_true,
      sym_false,
    ACTIONS(321), 2,
      anon_sym_DASH,
      anon_sym_PLUS,
    ACTIONS(325), 2,
      sym_decimal_lit,
      sym_octal_lit,
    STATE(112), 5,
      sym_block_lit,
      sym_full_ident,
      sym_bool,
      sym_int_lit,
      sym_string,
  [2335] = 14,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(262), 1,
      anon_sym_LBRACE,
    ACTIONS(270), 1,
      sym_identifier,
    ACTIONS(276), 1,
      sym_hex_lit,
    ACTIONS(278), 1,
      sym_float_lit,
    ACTIONS(280), 1,
      anon_sym_DQUOTE,
    ACTIONS(282), 1,
      anon_sym_SQUOTE,
    ACTIONS(335), 1,
      anon_sym_LBRACK,
    STATE(93), 1,
      aux_sym_string_repeat3,
    STATE(139), 1,
      sym_constant,
    ACTIONS(264), 2,
      anon_sym_DASH,
      anon_sym_PLUS,
    ACTIONS(272), 2,
      sym_true,
      sym_false,
    ACTIONS(274), 2,
      sym_decimal_lit,
      sym_octal_lit,
    STATE(112), 5,
      sym_block_lit,
      sym_full_ident,
      sym_bool,
      sym_int_lit,
      sym_string,
  [2385] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(337), 3,
      anon_sym_SEMI,
      anon_sym_DOT,
      anon_sym_RBRACE,
    ACTIONS(339), 17,
      anon_sym_option,
      anon_sym_int32,
      anon_sym_int64,
      anon_sym_uint32,
      anon_sym_uint64,
      anon_sym_sint32,
      anon_sym_sint64,
      anon_sym_fixed32,
      anon_sym_fixed64,
      anon_sym_sfixed32,
      anon_sym_sfixed64,
      anon_sym_bool,
      anon_sym_string,
      anon_sym_double,
      anon_sym_float,
      anon_sym_bytes,
      sym_identifier,
  [2413] = 12,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(7), 1,
      anon_sym_SEMI,
    ACTIONS(13), 1,
      anon_sym_import,
    ACTIONS(15), 1,
      anon_sym_option,
    ACTIONS(17), 1,
      anon_sym_package,
    ACTIONS(21), 1,
      anon_sym_enum,
    ACTIONS(23), 1,
      anon_sym_message,
    ACTIONS(25), 1,
      anon_sym_extend,
    ACTIONS(27), 1,
      anon_sym_service,
    ACTIONS(290), 1,
      ts_builtin_sym_end,
    ACTIONS(19), 2,
      anon_sym_export,
      anon_sym_local,
    STATE(45), 9,
      sym_empty_statement,
      sym_import,
      sym_package,
      sym_option,
      sym_enum,
      sym_message,
      sym_extend,
      sym_service,
      aux_sym_source_file_repeat1,
  [2459] = 14,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(262), 1,
      anon_sym_LBRACE,
    ACTIONS(270), 1,
      sym_identifier,
    ACTIONS(278), 1,
      sym_float_lit,
    ACTIONS(280), 1,
      anon_sym_DQUOTE,
    ACTIONS(282), 1,
      anon_sym_SQUOTE,
    ACTIONS(327), 1,
      sym_hex_lit,
    ACTIONS(341), 1,
      anon_sym_RBRACK,
    STATE(93), 1,
      aux_sym_string_repeat3,
    STATE(195), 1,
      sym_constant,
    ACTIONS(272), 2,
      sym_true,
      sym_false,
    ACTIONS(321), 2,
      anon_sym_DASH,
      anon_sym_PLUS,
    ACTIONS(325), 2,
      sym_decimal_lit,
      sym_octal_lit,
    STATE(112), 5,
      sym_block_lit,
      sym_full_ident,
      sym_bool,
      sym_int_lit,
      sym_string,
  [2509] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(211), 3,
      anon_sym_SEMI,
      anon_sym_DOT,
      anon_sym_RBRACE,
    ACTIONS(213), 17,
      anon_sym_option,
      anon_sym_int32,
      anon_sym_int64,
      anon_sym_uint32,
      anon_sym_uint64,
      anon_sym_sint32,
      anon_sym_sint64,
      anon_sym_fixed32,
      anon_sym_fixed64,
      anon_sym_sfixed32,
      anon_sym_sfixed64,
      anon_sym_bool,
      anon_sym_string,
      anon_sym_double,
      anon_sym_float,
      anon_sym_bytes,
      sym_identifier,
  [2537] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(123), 3,
      anon_sym_SEMI,
      anon_sym_DOT,
      anon_sym_RBRACE,
    ACTIONS(125), 17,
      anon_sym_option,
      anon_sym_int32,
      anon_sym_int64,
      anon_sym_uint32,
      anon_sym_uint64,
      anon_sym_sint32,
      anon_sym_sint64,
      anon_sym_fixed32,
      anon_sym_fixed64,
      anon_sym_sfixed32,
      anon_sym_sfixed64,
      anon_sym_bool,
      anon_sym_string,
      anon_sym_double,
      anon_sym_float,
      anon_sym_bytes,
      sym_identifier,
  [2565] = 13,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(262), 1,
      anon_sym_LBRACE,
    ACTIONS(270), 1,
      sym_identifier,
    ACTIONS(278), 1,
      sym_float_lit,
    ACTIONS(280), 1,
      anon_sym_DQUOTE,
    ACTIONS(282), 1,
      anon_sym_SQUOTE,
    ACTIONS(327), 1,
      sym_hex_lit,
    STATE(93), 1,
      aux_sym_string_repeat3,
    STATE(327), 1,
      sym_constant,
    ACTIONS(272), 2,
      sym_true,
      sym_false,
    ACTIONS(321), 2,
      anon_sym_DASH,
      anon_sym_PLUS,
    ACTIONS(325), 2,
      sym_decimal_lit,
      sym_octal_lit,
    STATE(112), 5,
      sym_block_lit,
      sym_full_ident,
      sym_bool,
      sym_int_lit,
      sym_string,
  [2612] = 13,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(262), 1,
      anon_sym_LBRACE,
    ACTIONS(270), 1,
      sym_identifier,
    ACTIONS(278), 1,
      sym_float_lit,
    ACTIONS(280), 1,
      anon_sym_DQUOTE,
    ACTIONS(282), 1,
      anon_sym_SQUOTE,
    ACTIONS(327), 1,
      sym_hex_lit,
    STATE(93), 1,
      aux_sym_string_repeat3,
    STATE(308), 1,
      sym_constant,
    ACTIONS(272), 2,
      sym_true,
      sym_false,
    ACTIONS(321), 2,
      anon_sym_DASH,
      anon_sym_PLUS,
    ACTIONS(325), 2,
      sym_decimal_lit,
      sym_octal_lit,
    STATE(112), 5,
      sym_block_lit,
      sym_full_ident,
      sym_bool,
      sym_int_lit,
      sym_string,
  [2659] = 13,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(262), 1,
      anon_sym_LBRACE,
    ACTIONS(270), 1,
      sym_identifier,
    ACTIONS(278), 1,
      sym_float_lit,
    ACTIONS(280), 1,
      anon_sym_DQUOTE,
    ACTIONS(282), 1,
      anon_sym_SQUOTE,
    ACTIONS(327), 1,
      sym_hex_lit,
    STATE(93), 1,
      aux_sym_string_repeat3,
    STATE(232), 1,
      sym_constant,
    ACTIONS(272), 2,
      sym_true,
      sym_false,
    ACTIONS(321), 2,
      anon_sym_DASH,
      anon_sym_PLUS,
    ACTIONS(325), 2,
      sym_decimal_lit,
      sym_octal_lit,
    STATE(112), 5,
      sym_block_lit,
      sym_full_ident,
      sym_bool,
      sym_int_lit,
      sym_string,
  [2706] = 13,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(262), 1,
      anon_sym_LBRACE,
    ACTIONS(270), 1,
      sym_identifier,
    ACTIONS(278), 1,
      sym_float_lit,
    ACTIONS(280), 1,
      anon_sym_DQUOTE,
    ACTIONS(282), 1,
      anon_sym_SQUOTE,
    ACTIONS(327), 1,
      sym_hex_lit,
    STATE(93), 1,
      aux_sym_string_repeat3,
    STATE(222), 1,
      sym_constant,
    ACTIONS(272), 2,
      sym_true,
      sym_false,
    ACTIONS(321), 2,
      anon_sym_DASH,
      anon_sym_PLUS,
    ACTIONS(325), 2,
      sym_decimal_lit,
      sym_octal_lit,
    STATE(112), 5,
      sym_block_lit,
      sym_full_ident,
      sym_bool,
      sym_int_lit,
      sym_string,
  [2753] = 13,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(262), 1,
      anon_sym_LBRACE,
    ACTIONS(270), 1,
      sym_identifier,
    ACTIONS(278), 1,
      sym_float_lit,
    ACTIONS(280), 1,
      anon_sym_DQUOTE,
    ACTIONS(282), 1,
      anon_sym_SQUOTE,
    ACTIONS(327), 1,
      sym_hex_lit,
    STATE(93), 1,
      aux_sym_string_repeat3,
    STATE(251), 1,
      sym_constant,
    ACTIONS(272), 2,
      sym_true,
      sym_false,
    ACTIONS(321), 2,
      anon_sym_DASH,
      anon_sym_PLUS,
    ACTIONS(325), 2,
      sym_decimal_lit,
      sym_octal_lit,
    STATE(112), 5,
      sym_block_lit,
      sym_full_ident,
      sym_bool,
      sym_int_lit,
      sym_string,
  [2800] = 13,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(262), 1,
      anon_sym_LBRACE,
    ACTIONS(270), 1,
      sym_identifier,
    ACTIONS(278), 1,
      sym_float_lit,
    ACTIONS(280), 1,
      anon_sym_DQUOTE,
    ACTIONS(282), 1,
      anon_sym_SQUOTE,
    ACTIONS(327), 1,
      sym_hex_lit,
    STATE(93), 1,
      aux_sym_string_repeat3,
    STATE(322), 1,
      sym_constant,
    ACTIONS(272), 2,
      sym_true,
      sym_false,
    ACTIONS(321), 2,
      anon_sym_DASH,
      anon_sym_PLUS,
    ACTIONS(325), 2,
      sym_decimal_lit,
      sym_octal_lit,
    STATE(112), 5,
      sym_block_lit,
      sym_full_ident,
      sym_bool,
      sym_int_lit,
      sym_string,
  [2847] = 13,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(262), 1,
      anon_sym_LBRACE,
    ACTIONS(270), 1,
      sym_identifier,
    ACTIONS(278), 1,
      sym_float_lit,
    ACTIONS(280), 1,
      anon_sym_DQUOTE,
    ACTIONS(282), 1,
      anon_sym_SQUOTE,
    ACTIONS(327), 1,
      sym_hex_lit,
    STATE(93), 1,
      aux_sym_string_repeat3,
    STATE(326), 1,
      sym_constant,
    ACTIONS(272), 2,
      sym_true,
      sym_false,
    ACTIONS(321), 2,
      anon_sym_DASH,
      anon_sym_PLUS,
    ACTIONS(325), 2,
      sym_decimal_lit,
      sym_octal_lit,
    STATE(112), 5,
      sym_block_lit,
      sym_full_ident,
      sym_bool,
      sym_int_lit,
      sym_string,
  [2894] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(123), 13,
      ts_builtin_sym_end,
      anon_sym_SEMI,
      anon_sym_import,
      anon_sym_option,
      anon_sym_package,
      anon_sym_export,
      anon_sym_local,
      anon_sym_enum,
      anon_sym_RBRACE,
      anon_sym_message,
      anon_sym_extend,
      anon_sym_service,
      anon_sym_rpc,
  [2913] = 3,
    ACTIONS(3), 1,
      sym_comment,
    STATE(335), 1,
      sym_key_type,
    ACTIONS(343), 12,
      anon_sym_int32,
      anon_sym_int64,
      anon_sym_uint32,
      anon_sym_uint64,
      anon_sym_sint32,
      anon_sym_sint64,
      anon_sym_fixed32,
      anon_sym_fixed64,
      anon_sym_sfixed32,
      anon_sym_sfixed64,
      anon_sym_bool,
      anon_sym_string,
  [2934] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(211), 13,
      ts_builtin_sym_end,
      anon_sym_SEMI,
      anon_sym_import,
      anon_sym_option,
      anon_sym_package,
      anon_sym_export,
      anon_sym_local,
      anon_sym_enum,
      anon_sym_RBRACE,
      anon_sym_message,
      anon_sym_extend,
      anon_sym_service,
      anon_sym_rpc,
  [2953] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(345), 11,
      ts_builtin_sym_end,
      anon_sym_SEMI,
      anon_sym_import,
      anon_sym_option,
      anon_sym_package,
      anon_sym_export,
      anon_sym_local,
      anon_sym_enum,
      anon_sym_message,
      anon_sym_extend,
      anon_sym_service,
  [2970] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(347), 11,
      ts_builtin_sym_end,
      anon_sym_SEMI,
      anon_sym_import,
      anon_sym_option,
      anon_sym_package,
      anon_sym_export,
      anon_sym_local,
      anon_sym_enum,
      anon_sym_message,
      anon_sym_extend,
      anon_sym_service,
  [2987] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(203), 11,
      ts_builtin_sym_end,
      anon_sym_SEMI,
      anon_sym_import,
      anon_sym_option,
      anon_sym_package,
      anon_sym_export,
      anon_sym_local,
      anon_sym_enum,
      anon_sym_message,
      anon_sym_extend,
      anon_sym_service,
  [3004] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(179), 11,
      ts_builtin_sym_end,
      anon_sym_SEMI,
      anon_sym_import,
      anon_sym_option,
      anon_sym_package,
      anon_sym_export,
      anon_sym_local,
      anon_sym_enum,
      anon_sym_message,
      anon_sym_extend,
      anon_sym_service,
  [3021] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(349), 11,
      ts_builtin_sym_end,
      anon_sym_SEMI,
      anon_sym_import,
      anon_sym_option,
      anon_sym_package,
      anon_sym_export,
      anon_sym_local,
      anon_sym_enum,
      anon_sym_message,
      anon_sym_extend,
      anon_sym_service,
  [3038] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(119), 11,
      ts_builtin_sym_end,
      anon_sym_SEMI,
      anon_sym_import,
      anon_sym_option,
      anon_sym_package,
      anon_sym_export,
      anon_sym_local,
      anon_sym_enum,
      anon_sym_message,
      anon_sym_extend,
      anon_sym_service,
  [3055] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(351), 11,
      ts_builtin_sym_end,
      anon_sym_SEMI,
      anon_sym_import,
      anon_sym_option,
      anon_sym_package,
      anon_sym_export,
      anon_sym_local,
      anon_sym_enum,
      anon_sym_message,
      anon_sym_extend,
      anon_sym_service,
  [3072] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(175), 11,
      ts_builtin_sym_end,
      anon_sym_SEMI,
      anon_sym_import,
      anon_sym_option,
      anon_sym_package,
      anon_sym_export,
      anon_sym_local,
      anon_sym_enum,
      anon_sym_message,
      anon_sym_extend,
      anon_sym_service,
  [3089] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(183), 11,
      ts_builtin_sym_end,
      anon_sym_SEMI,
      anon_sym_import,
      anon_sym_option,
      anon_sym_package,
      anon_sym_export,
      anon_sym_local,
      anon_sym_enum,
      anon_sym_message,
      anon_sym_extend,
      anon_sym_service,
  [3106] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(353), 11,
      ts_builtin_sym_end,
      anon_sym_SEMI,
      anon_sym_import,
      anon_sym_option,
      anon_sym_package,
      anon_sym_export,
      anon_sym_local,
      anon_sym_enum,
      anon_sym_message,
      anon_sym_extend,
      anon_sym_service,
  [3123] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(355), 11,
      ts_builtin_sym_end,
      anon_sym_SEMI,
      anon_sym_import,
      anon_sym_option,
      anon_sym_package,
      anon_sym_export,
      anon_sym_local,
      anon_sym_enum,
      anon_sym_message,
      anon_sym_extend,
      anon_sym_service,
  [3140] = 4,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(359), 1,
      anon_sym_DOT,
    STATE(78), 1,
      aux_sym__option_name_repeat1,
    ACTIONS(357), 9,
      anon_sym_SEMI,
      anon_sym_EQ,
      anon_sym_RPAREN,
      anon_sym_LBRACE,
      anon_sym_RBRACE,
      anon_sym_LBRACK,
      anon_sym_COMMA,
      anon_sym_RBRACK,
      sym_identifier,
  [3161] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(187), 11,
      ts_builtin_sym_end,
      anon_sym_SEMI,
      anon_sym_import,
      anon_sym_option,
      anon_sym_package,
      anon_sym_export,
      anon_sym_local,
      anon_sym_enum,
      anon_sym_message,
      anon_sym_extend,
      anon_sym_service,
  [3178] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(191), 11,
      ts_builtin_sym_end,
      anon_sym_SEMI,
      anon_sym_import,
      anon_sym_option,
      anon_sym_package,
      anon_sym_export,
      anon_sym_local,
      anon_sym_enum,
      anon_sym_message,
      anon_sym_extend,
      anon_sym_service,
  [3195] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(195), 11,
      ts_builtin_sym_end,
      anon_sym_SEMI,
      anon_sym_import,
      anon_sym_option,
      anon_sym_package,
      anon_sym_export,
      anon_sym_local,
      anon_sym_enum,
      anon_sym_message,
      anon_sym_extend,
      anon_sym_service,
  [3212] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(199), 11,
      ts_builtin_sym_end,
      anon_sym_SEMI,
      anon_sym_import,
      anon_sym_option,
      anon_sym_package,
      anon_sym_export,
      anon_sym_local,
      anon_sym_enum,
      anon_sym_message,
      anon_sym_extend,
      anon_sym_service,
  [3229] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(362), 11,
      ts_builtin_sym_end,
      anon_sym_SEMI,
      anon_sym_import,
      anon_sym_option,
      anon_sym_package,
      anon_sym_export,
      anon_sym_local,
      anon_sym_enum,
      anon_sym_message,
      anon_sym_extend,
      anon_sym_service,
  [3246] = 4,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(366), 1,
      anon_sym_DOT,
    STATE(78), 1,
      aux_sym__option_name_repeat1,
    ACTIONS(364), 8,
      anon_sym_SEMI,
      anon_sym_RPAREN,
      anon_sym_LBRACE,
      anon_sym_RBRACE,
      anon_sym_LBRACK,
      anon_sym_COMMA,
      anon_sym_RBRACK,
      sym_identifier,
  [3266] = 7,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(368), 1,
      anon_sym_SEMI,
    ACTIONS(371), 1,
      anon_sym_option,
    ACTIONS(374), 1,
      anon_sym_RBRACE,
    ACTIONS(376), 1,
      anon_sym_reserved,
    ACTIONS(379), 1,
      sym_identifier,
    STATE(85), 5,
      sym_empty_statement,
      sym_option,
      sym_enum_field,
      sym_reserved,
      aux_sym_enum_body_repeat1,
  [3292] = 7,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(382), 1,
      anon_sym_SEMI,
    ACTIONS(384), 1,
      anon_sym_option,
    ACTIONS(386), 1,
      anon_sym_RBRACE,
    ACTIONS(388), 1,
      anon_sym_reserved,
    ACTIONS(390), 1,
      sym_identifier,
    STATE(87), 5,
      sym_empty_statement,
      sym_option,
      sym_enum_field,
      sym_reserved,
      aux_sym_enum_body_repeat1,
  [3318] = 7,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(382), 1,
      anon_sym_SEMI,
    ACTIONS(384), 1,
      anon_sym_option,
    ACTIONS(388), 1,
      anon_sym_reserved,
    ACTIONS(390), 1,
      sym_identifier,
    ACTIONS(392), 1,
      anon_sym_RBRACE,
    STATE(85), 5,
      sym_empty_statement,
      sym_option,
      sym_enum_field,
      sym_reserved,
      aux_sym_enum_body_repeat1,
  [3344] = 7,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(382), 1,
      anon_sym_SEMI,
    ACTIONS(384), 1,
      anon_sym_option,
    ACTIONS(388), 1,
      anon_sym_reserved,
    ACTIONS(390), 1,
      sym_identifier,
    ACTIONS(394), 1,
      anon_sym_RBRACE,
    STATE(91), 5,
      sym_empty_statement,
      sym_option,
      sym_enum_field,
      sym_reserved,
      aux_sym_enum_body_repeat1,
  [3370] = 4,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(366), 1,
      anon_sym_DOT,
    STATE(84), 1,
      aux_sym__option_name_repeat1,
    ACTIONS(396), 8,
      anon_sym_SEMI,
      anon_sym_RPAREN,
      anon_sym_LBRACE,
      anon_sym_RBRACE,
      anon_sym_LBRACK,
      anon_sym_COMMA,
      anon_sym_RBRACK,
      sym_identifier,
  [3390] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(357), 10,
      anon_sym_SEMI,
      anon_sym_EQ,
      anon_sym_RPAREN,
      anon_sym_DOT,
      anon_sym_LBRACE,
      anon_sym_RBRACE,
      anon_sym_LBRACK,
      anon_sym_COMMA,
      anon_sym_RBRACK,
      sym_identifier,
  [3406] = 7,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(382), 1,
      anon_sym_SEMI,
    ACTIONS(384), 1,
      anon_sym_option,
    ACTIONS(388), 1,
      anon_sym_reserved,
    ACTIONS(390), 1,
      sym_identifier,
    ACTIONS(398), 1,
      anon_sym_RBRACE,
    STATE(85), 5,
      sym_empty_statement,
      sym_option,
      sym_enum_field,
      sym_reserved,
      aux_sym_enum_body_repeat1,
  [3432] = 5,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(402), 1,
      anon_sym_DQUOTE,
    ACTIONS(405), 1,
      anon_sym_SQUOTE,
    STATE(92), 1,
      aux_sym_string_repeat3,
    ACTIONS(400), 6,
      anon_sym_SEMI,
      anon_sym_RBRACE,
      anon_sym_LBRACK,
      anon_sym_COMMA,
      anon_sym_RBRACK,
      sym_identifier,
  [3453] = 5,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(280), 1,
      anon_sym_DQUOTE,
    ACTIONS(282), 1,
      anon_sym_SQUOTE,
    STATE(92), 1,
      aux_sym_string_repeat3,
    ACTIONS(408), 6,
      anon_sym_SEMI,
      anon_sym_RBRACE,
      anon_sym_LBRACK,
      anon_sym_COMMA,
      anon_sym_RBRACK,
      sym_identifier,
  [3474] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(400), 8,
      anon_sym_SEMI,
      anon_sym_RBRACE,
      anon_sym_LBRACK,
      anon_sym_COMMA,
      anon_sym_RBRACK,
      sym_identifier,
      anon_sym_DQUOTE,
      anon_sym_SQUOTE,
  [3488] = 7,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(325), 1,
      sym_octal_lit,
    ACTIONS(410), 1,
      sym_reserved_identifier,
    STATE(179), 1,
      sym_range,
    STATE(189), 1,
      sym_int_lit,
    ACTIONS(327), 2,
      sym_decimal_lit,
      sym_hex_lit,
    STATE(325), 2,
      sym_ranges,
      sym_reserved_field_names,
  [3512] = 6,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(412), 1,
      anon_sym_SEMI,
    ACTIONS(415), 1,
      anon_sym_option,
    ACTIONS(418), 1,
      anon_sym_RBRACE,
    ACTIONS(420), 1,
      anon_sym_rpc,
    STATE(96), 4,
      sym_empty_statement,
      sym_option,
      sym_rpc,
      aux_sym_service_repeat1,
  [3534] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(423), 8,
      anon_sym_SEMI,
      anon_sym_RBRACE,
      anon_sym_LBRACK,
      anon_sym_COMMA,
      anon_sym_RBRACK,
      sym_identifier,
      anon_sym_DQUOTE,
      anon_sym_SQUOTE,
  [3548] = 7,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(325), 1,
      sym_octal_lit,
    ACTIONS(410), 1,
      sym_reserved_identifier,
    STATE(179), 1,
      sym_range,
    STATE(189), 1,
      sym_int_lit,
    ACTIONS(327), 2,
      sym_decimal_lit,
      sym_hex_lit,
    STATE(303), 2,
      sym_ranges,
      sym_reserved_field_names,
  [3572] = 6,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(7), 1,
      anon_sym_SEMI,
    ACTIONS(15), 1,
      anon_sym_option,
    ACTIONS(425), 1,
      anon_sym_RBRACE,
    ACTIONS(427), 1,
      anon_sym_rpc,
    STATE(96), 4,
      sym_empty_statement,
      sym_option,
      sym_rpc,
      aux_sym_service_repeat1,
  [3594] = 6,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(7), 1,
      anon_sym_SEMI,
    ACTIONS(15), 1,
      anon_sym_option,
    ACTIONS(427), 1,
      anon_sym_rpc,
    ACTIONS(429), 1,
      anon_sym_RBRACE,
    STATE(99), 4,
      sym_empty_statement,
      sym_option,
      sym_rpc,
      aux_sym_service_repeat1,
  [3616] = 6,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(280), 1,
      anon_sym_DQUOTE,
    ACTIONS(282), 1,
      anon_sym_SQUOTE,
    STATE(93), 1,
      aux_sym_string_repeat3,
    STATE(302), 1,
      sym_string,
    ACTIONS(431), 3,
      anon_sym_weak,
      anon_sym_public,
      anon_sym_option,
  [3637] = 5,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(7), 1,
      anon_sym_SEMI,
    ACTIONS(15), 1,
      anon_sym_option,
    ACTIONS(433), 1,
      anon_sym_RBRACE,
    STATE(104), 3,
      sym_empty_statement,
      sym_option,
      aux_sym_rpc_repeat1,
  [3655] = 5,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(7), 1,
      anon_sym_SEMI,
    ACTIONS(15), 1,
      anon_sym_option,
    ACTIONS(435), 1,
      anon_sym_RBRACE,
    STATE(106), 3,
      sym_empty_statement,
      sym_option,
      aux_sym_rpc_repeat1,
  [3673] = 5,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(7), 1,
      anon_sym_SEMI,
    ACTIONS(15), 1,
      anon_sym_option,
    ACTIONS(435), 1,
      anon_sym_RBRACE,
    STATE(107), 3,
      sym_empty_statement,
      sym_option,
      aux_sym_rpc_repeat1,
  [3691] = 5,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(7), 1,
      anon_sym_SEMI,
    ACTIONS(15), 1,
      anon_sym_option,
    ACTIONS(437), 1,
      anon_sym_RBRACE,
    STATE(108), 3,
      sym_empty_statement,
      sym_option,
      aux_sym_rpc_repeat1,
  [3709] = 5,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(7), 1,
      anon_sym_SEMI,
    ACTIONS(15), 1,
      anon_sym_option,
    ACTIONS(437), 1,
      anon_sym_RBRACE,
    STATE(107), 3,
      sym_empty_statement,
      sym_option,
      aux_sym_rpc_repeat1,
  [3727] = 5,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(439), 1,
      anon_sym_SEMI,
    ACTIONS(442), 1,
      anon_sym_option,
    ACTIONS(445), 1,
      anon_sym_RBRACE,
    STATE(107), 3,
      sym_empty_statement,
      sym_option,
      aux_sym_rpc_repeat1,
  [3745] = 5,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(7), 1,
      anon_sym_SEMI,
    ACTIONS(15), 1,
      anon_sym_option,
    ACTIONS(447), 1,
      anon_sym_RBRACE,
    STATE(107), 3,
      sym_empty_statement,
      sym_option,
      aux_sym_rpc_repeat1,
  [3763] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(258), 6,
      anon_sym_SEMI,
      anon_sym_LBRACE,
      anon_sym_LBRACK,
      anon_sym_COMMA,
      anon_sym_RBRACK,
      anon_sym_to,
  [3775] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(449), 6,
      anon_sym_SEMI,
      anon_sym_RBRACE,
      anon_sym_LBRACK,
      anon_sym_COMMA,
      anon_sym_RBRACK,
      sym_identifier,
  [3787] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(451), 6,
      anon_sym_SEMI,
      anon_sym_RBRACE,
      anon_sym_LBRACK,
      anon_sym_COMMA,
      anon_sym_RBRACK,
      sym_identifier,
  [3799] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(453), 6,
      anon_sym_SEMI,
      anon_sym_RBRACE,
      anon_sym_LBRACK,
      anon_sym_COMMA,
      anon_sym_RBRACK,
      sym_identifier,
  [3811] = 6,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(325), 1,
      sym_octal_lit,
    STATE(179), 1,
      sym_range,
    STATE(189), 1,
      sym_int_lit,
    STATE(286), 1,
      sym_ranges,
    ACTIONS(327), 2,
      sym_decimal_lit,
      sym_hex_lit,
  [3831] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(455), 6,
      anon_sym_SEMI,
      anon_sym_RBRACE,
      anon_sym_LBRACK,
      anon_sym_COMMA,
      anon_sym_RBRACK,
      sym_identifier,
  [3843] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(457), 6,
      anon_sym_SEMI,
      anon_sym_RBRACE,
      anon_sym_LBRACK,
      anon_sym_COMMA,
      anon_sym_RBRACK,
      sym_identifier,
  [3855] = 5,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(327), 1,
      sym_hex_lit,
    ACTIONS(459), 1,
      sym_float_lit,
    STATE(111), 1,
      sym_int_lit,
    ACTIONS(325), 2,
      sym_decimal_lit,
      sym_octal_lit,
  [3872] = 6,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(461), 1,
      anon_sym_LPAREN,
    ACTIONS(463), 1,
      sym_identifier,
    STATE(210), 1,
      sym_field_option,
    STATE(305), 1,
      sym_field_options,
    STATE(317), 1,
      sym__option_name,
  [3891] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(465), 2,
      anon_sym_SEMI,
      anon_sym_COMMA,
    ACTIONS(467), 3,
      anon_sym_RBRACE,
      anon_sym_LBRACK,
      sym_identifier,
  [3904] = 5,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(325), 1,
      sym_octal_lit,
    STATE(189), 1,
      sym_int_lit,
    STATE(229), 1,
      sym_range,
    ACTIONS(327), 2,
      sym_decimal_lit,
      sym_hex_lit,
  [3921] = 6,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(33), 1,
      anon_sym_DOT,
    ACTIONS(61), 1,
      sym_identifier,
    ACTIONS(469), 1,
      anon_sym_stream,
    STATE(271), 1,
      aux_sym_message_or_enum_type_repeat1,
    STATE(318), 1,
      sym_message_or_enum_type,
  [3940] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(471), 2,
      anon_sym_SEMI,
      anon_sym_COMMA,
    ACTIONS(473), 3,
      anon_sym_RBRACE,
      anon_sym_LBRACK,
      sym_identifier,
  [3953] = 6,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(461), 1,
      anon_sym_LPAREN,
    ACTIONS(463), 1,
      sym_identifier,
    STATE(210), 1,
      sym_field_option,
    STATE(317), 1,
      sym__option_name,
    STATE(331), 1,
      sym_field_options,
  [3972] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(475), 2,
      anon_sym_SEMI,
      anon_sym_RBRACE,
    ACTIONS(477), 3,
      anon_sym_option,
      anon_sym_reserved,
      sym_identifier,
  [3985] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(211), 2,
      anon_sym_SEMI,
      anon_sym_RBRACE,
    ACTIONS(213), 3,
      anon_sym_option,
      anon_sym_reserved,
      sym_identifier,
  [3998] = 6,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(461), 1,
      anon_sym_LPAREN,
    ACTIONS(463), 1,
      sym_identifier,
    STATE(210), 1,
      sym_field_option,
    STATE(317), 1,
      sym__option_name,
    STATE(332), 1,
      sym_field_options,
  [4017] = 5,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(325), 1,
      sym_octal_lit,
    STATE(36), 1,
      sym_int_lit,
    STATE(218), 1,
      sym_field_number,
    ACTIONS(327), 2,
      sym_decimal_lit,
      sym_hex_lit,
  [4034] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(479), 2,
      anon_sym_SEMI,
      anon_sym_COMMA,
    ACTIONS(481), 3,
      anon_sym_RBRACE,
      anon_sym_LBRACK,
      sym_identifier,
  [4047] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(258), 5,
      anon_sym_SEMI,
      anon_sym_RBRACE,
      anon_sym_LBRACK,
      anon_sym_COMMA,
      sym_identifier,
  [4058] = 5,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(325), 1,
      sym_octal_lit,
    STATE(36), 1,
      sym_int_lit,
    STATE(269), 1,
      sym_field_number,
    ACTIONS(327), 2,
      sym_decimal_lit,
      sym_hex_lit,
  [4075] = 5,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(325), 1,
      sym_octal_lit,
    ACTIONS(483), 1,
      anon_sym_DASH,
    STATE(256), 1,
      sym_int_lit,
    ACTIONS(327), 2,
      sym_decimal_lit,
      sym_hex_lit,
  [4092] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(485), 2,
      anon_sym_SEMI,
      anon_sym_RBRACE,
    ACTIONS(487), 3,
      anon_sym_option,
      anon_sym_reserved,
      sym_identifier,
  [4105] = 5,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(491), 1,
      sym_octal_lit,
    STATE(36), 1,
      sym_int_lit,
    STATE(37), 1,
      sym_field_number,
    ACTIONS(489), 2,
      sym_decimal_lit,
      sym_hex_lit,
  [4122] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(123), 2,
      anon_sym_SEMI,
      anon_sym_RBRACE,
    ACTIONS(125), 3,
      anon_sym_option,
      anon_sym_reserved,
      sym_identifier,
  [4135] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(493), 2,
      anon_sym_SEMI,
      anon_sym_COMMA,
    ACTIONS(495), 3,
      anon_sym_RBRACE,
      anon_sym_LBRACK,
      sym_identifier,
  [4148] = 5,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(325), 1,
      sym_octal_lit,
    STATE(36), 1,
      sym_int_lit,
    STATE(234), 1,
      sym_field_number,
    ACTIONS(327), 2,
      sym_decimal_lit,
      sym_hex_lit,
  [4165] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(497), 2,
      anon_sym_SEMI,
      anon_sym_RBRACE,
    ACTIONS(499), 3,
      anon_sym_option,
      anon_sym_reserved,
      sym_identifier,
  [4178] = 6,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(461), 1,
      anon_sym_LPAREN,
    ACTIONS(463), 1,
      sym_identifier,
    STATE(210), 1,
      sym_field_option,
    STATE(298), 1,
      sym_field_options,
    STATE(317), 1,
      sym__option_name,
  [4197] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(501), 2,
      anon_sym_SEMI,
      anon_sym_RBRACE,
    ACTIONS(503), 3,
      anon_sym_option,
      anon_sym_reserved,
      sym_identifier,
  [4210] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(505), 2,
      anon_sym_SEMI,
      anon_sym_COMMA,
    ACTIONS(507), 3,
      anon_sym_RBRACE,
      anon_sym_LBRACK,
      sym_identifier,
  [4223] = 5,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(325), 1,
      sym_octal_lit,
    STATE(36), 1,
      sym_int_lit,
    STATE(253), 1,
      sym_field_number,
    ACTIONS(327), 2,
      sym_decimal_lit,
      sym_hex_lit,
  [4240] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(509), 2,
      anon_sym_SEMI,
      anon_sym_COMMA,
    ACTIONS(511), 3,
      anon_sym_RBRACE,
      anon_sym_LBRACK,
      sym_identifier,
  [4253] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(513), 2,
      anon_sym_SEMI,
      anon_sym_COMMA,
    ACTIONS(515), 3,
      anon_sym_RBRACE,
      anon_sym_LBRACK,
      sym_identifier,
  [4266] = 5,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(325), 1,
      sym_octal_lit,
    ACTIONS(517), 1,
      anon_sym_max,
    STATE(230), 1,
      sym_int_lit,
    ACTIONS(327), 2,
      sym_decimal_lit,
      sym_hex_lit,
  [4283] = 5,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(276), 1,
      sym_hex_lit,
    ACTIONS(459), 1,
      sym_float_lit,
    STATE(111), 1,
      sym_int_lit,
    ACTIONS(274), 2,
      sym_decimal_lit,
      sym_octal_lit,
  [4300] = 5,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(325), 1,
      sym_octal_lit,
    STATE(36), 1,
      sym_int_lit,
    STATE(235), 1,
      sym_field_number,
    ACTIONS(327), 2,
      sym_decimal_lit,
      sym_hex_lit,
  [4317] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(519), 2,
      anon_sym_SEMI,
      anon_sym_RBRACE,
    ACTIONS(521), 3,
      anon_sym_option,
      anon_sym_reserved,
      sym_identifier,
  [4330] = 6,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(461), 1,
      anon_sym_LPAREN,
    ACTIONS(463), 1,
      sym_identifier,
    STATE(210), 1,
      sym_field_option,
    STATE(273), 1,
      sym_field_options,
    STATE(317), 1,
      sym__option_name,
  [4349] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(207), 2,
      anon_sym_SEMI,
      anon_sym_RBRACE,
    ACTIONS(209), 3,
      anon_sym_option,
      anon_sym_reserved,
      sym_identifier,
  [4362] = 5,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(325), 1,
      sym_octal_lit,
    STATE(36), 1,
      sym_int_lit,
    STATE(219), 1,
      sym_field_number,
    ACTIONS(327), 2,
      sym_decimal_lit,
      sym_hex_lit,
  [4379] = 6,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(33), 1,
      anon_sym_DOT,
    ACTIONS(61), 1,
      sym_identifier,
    ACTIONS(523), 1,
      anon_sym_stream,
    STATE(271), 1,
      aux_sym_message_or_enum_type_repeat1,
    STATE(341), 1,
      sym_message_or_enum_type,
  [4398] = 6,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(33), 1,
      anon_sym_DOT,
    ACTIONS(61), 1,
      sym_identifier,
    ACTIONS(525), 1,
      anon_sym_stream,
    STATE(271), 1,
      aux_sym_message_or_enum_type_repeat1,
    STATE(337), 1,
      sym_message_or_enum_type,
  [4417] = 4,
    ACTIONS(527), 1,
      anon_sym_SQUOTE,
    ACTIONS(531), 1,
      sym_comment,
    STATE(160), 1,
      aux_sym_string_repeat2,
    ACTIONS(529), 2,
      aux_sym_string_token2,
      sym_escape_sequence,
  [4431] = 5,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(533), 1,
      anon_sym_RBRACE,
    ACTIONS(535), 1,
      anon_sym_LBRACK,
    ACTIONS(537), 1,
      sym_identifier,
    STATE(161), 1,
      aux_sym_block_lit_repeat2,
  [4447] = 5,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(461), 1,
      anon_sym_LPAREN,
    ACTIONS(463), 1,
      sym_identifier,
    STATE(194), 1,
      sym_enum_value_option,
    STATE(310), 1,
      sym__option_name,
  [4463] = 5,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(33), 1,
      anon_sym_DOT,
    ACTIONS(539), 1,
      sym_identifier,
    STATE(271), 1,
      aux_sym_message_or_enum_type_repeat1,
    STATE(288), 1,
      sym_message_or_enum_type,
  [4479] = 5,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(461), 1,
      anon_sym_LPAREN,
    ACTIONS(463), 1,
      sym_identifier,
    STATE(201), 1,
      sym_enum_value_option,
    STATE(310), 1,
      sym__option_name,
  [4495] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(543), 1,
      anon_sym_DOT,
    ACTIONS(541), 3,
      anon_sym_RPAREN,
      anon_sym_GT,
      sym_identifier,
  [4507] = 5,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(461), 1,
      anon_sym_LPAREN,
    ACTIONS(463), 1,
      sym_identifier,
    STATE(223), 1,
      sym_enum_value_option,
    STATE(310), 1,
      sym__option_name,
  [4523] = 4,
    ACTIONS(531), 1,
      sym_comment,
    ACTIONS(545), 1,
      anon_sym_DQUOTE,
    STATE(177), 1,
      aux_sym_string_repeat1,
    ACTIONS(547), 2,
      aux_sym_string_token1,
      sym_escape_sequence,
  [4537] = 4,
    ACTIONS(531), 1,
      sym_comment,
    ACTIONS(545), 1,
      anon_sym_SQUOTE,
    STATE(178), 1,
      aux_sym_string_repeat2,
    ACTIONS(549), 2,
      aux_sym_string_token2,
      sym_escape_sequence,
  [4551] = 5,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(535), 1,
      anon_sym_LBRACK,
    ACTIONS(537), 1,
      sym_identifier,
    ACTIONS(551), 1,
      anon_sym_RBRACE,
    STATE(174), 1,
      aux_sym_block_lit_repeat2,
  [4567] = 5,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(461), 1,
      anon_sym_LPAREN,
    ACTIONS(463), 1,
      sym_identifier,
    STATE(233), 1,
      sym_field_option,
    STATE(317), 1,
      sym__option_name,
  [4583] = 5,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(33), 1,
      anon_sym_DOT,
    ACTIONS(539), 1,
      sym_identifier,
    STATE(271), 1,
      aux_sym_message_or_enum_type_repeat1,
    STATE(337), 1,
      sym_message_or_enum_type,
  [4599] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(543), 1,
      anon_sym_DOT,
    ACTIONS(553), 3,
      anon_sym_RPAREN,
      anon_sym_GT,
      sym_identifier,
  [4611] = 5,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(33), 1,
      anon_sym_DOT,
    ACTIONS(539), 1,
      sym_identifier,
    STATE(271), 1,
      aux_sym_message_or_enum_type_repeat1,
    STATE(278), 1,
      sym_message_or_enum_type,
  [4627] = 5,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(280), 1,
      anon_sym_DQUOTE,
    ACTIONS(282), 1,
      anon_sym_SQUOTE,
    STATE(93), 1,
      aux_sym_string_repeat3,
    STATE(295), 1,
      sym_string,
  [4643] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(555), 4,
      anon_sym_SEMI,
      anon_sym_option,
      anon_sym_RBRACE,
      anon_sym_rpc,
  [4653] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(557), 4,
      anon_sym_SEMI,
      anon_sym_option,
      anon_sym_RBRACE,
      anon_sym_rpc,
  [4663] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(559), 4,
      anon_sym_SEMI,
      anon_sym_option,
      anon_sym_RBRACE,
      anon_sym_rpc,
  [4673] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(561), 4,
      anon_sym_SEMI,
      anon_sym_option,
      anon_sym_RBRACE,
      anon_sym_rpc,
  [4683] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(563), 4,
      anon_sym_SEMI,
      anon_sym_option,
      anon_sym_RBRACE,
      anon_sym_rpc,
  [4693] = 5,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(280), 1,
      anon_sym_DQUOTE,
    ACTIONS(282), 1,
      anon_sym_SQUOTE,
    STATE(93), 1,
      aux_sym_string_repeat3,
    STATE(284), 1,
      sym_string,
  [4709] = 4,
    ACTIONS(527), 1,
      anon_sym_DQUOTE,
    ACTIONS(531), 1,
      sym_comment,
    STATE(159), 1,
      aux_sym_string_repeat1,
    ACTIONS(565), 2,
      aux_sym_string_token1,
      sym_escape_sequence,
  [4723] = 5,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(515), 1,
      anon_sym_RBRACE,
    ACTIONS(567), 1,
      anon_sym_LBRACK,
    ACTIONS(570), 1,
      sym_identifier,
    STATE(174), 1,
      aux_sym_block_lit_repeat2,
  [4739] = 4,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(325), 1,
      sym_octal_lit,
    STATE(231), 1,
      sym_int_lit,
    ACTIONS(327), 2,
      sym_decimal_lit,
      sym_hex_lit,
  [4753] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(543), 1,
      anon_sym_DOT,
    ACTIONS(573), 3,
      anon_sym_RPAREN,
      anon_sym_GT,
      sym_identifier,
  [4765] = 4,
    ACTIONS(531), 1,
      sym_comment,
    ACTIONS(575), 1,
      anon_sym_DQUOTE,
    STATE(177), 1,
      aux_sym_string_repeat1,
    ACTIONS(577), 2,
      aux_sym_string_token1,
      sym_escape_sequence,
  [4779] = 4,
    ACTIONS(531), 1,
      sym_comment,
    ACTIONS(580), 1,
      anon_sym_SQUOTE,
    STATE(178), 1,
      aux_sym_string_repeat2,
    ACTIONS(582), 2,
      aux_sym_string_token2,
      sym_escape_sequence,
  [4793] = 4,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(585), 1,
      anon_sym_SEMI,
    ACTIONS(587), 1,
      anon_sym_COMMA,
    STATE(209), 1,
      aux_sym_ranges_repeat1,
  [4806] = 4,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(589), 1,
      anon_sym_COMMA,
    ACTIONS(591), 1,
      anon_sym_RBRACK,
    STATE(181), 1,
      aux_sym_enum_field_repeat1,
  [4819] = 4,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(593), 1,
      anon_sym_COMMA,
    ACTIONS(596), 1,
      anon_sym_RBRACK,
    STATE(181), 1,
      aux_sym_enum_field_repeat1,
  [4832] = 4,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(333), 1,
      anon_sym_RBRACK,
    ACTIONS(598), 1,
      anon_sym_COMMA,
    STATE(199), 1,
      aux_sym_block_lit_repeat1,
  [4845] = 4,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(333), 1,
      anon_sym_RBRACK,
    ACTIONS(598), 1,
      anon_sym_COMMA,
    STATE(200), 1,
      aux_sym_block_lit_repeat1,
  [4858] = 4,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(600), 1,
      anon_sym_COMMA,
    ACTIONS(602), 1,
      anon_sym_RBRACK,
    STATE(191), 1,
      aux_sym_field_options_repeat1,
  [4871] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(473), 3,
      anon_sym_RBRACE,
      anon_sym_LBRACK,
      sym_identifier,
  [4880] = 4,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(604), 1,
      anon_sym_SEMI,
    ACTIONS(606), 1,
      anon_sym_COMMA,
    STATE(207), 1,
      aux_sym_reserved_field_names_repeat1,
  [4893] = 4,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(598), 1,
      anon_sym_COMMA,
    ACTIONS(608), 1,
      anon_sym_RBRACK,
    STATE(199), 1,
      aux_sym_block_lit_repeat1,
  [4906] = 4,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(461), 1,
      anon_sym_LPAREN,
    ACTIONS(463), 1,
      sym_identifier,
    STATE(340), 1,
      sym__option_name,
  [4919] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(612), 1,
      anon_sym_to,
    ACTIONS(610), 2,
      anon_sym_SEMI,
      anon_sym_COMMA,
  [4930] = 4,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(366), 1,
      anon_sym_DOT,
    ACTIONS(614), 1,
      anon_sym_EQ,
    STATE(78), 1,
      aux_sym__option_name_repeat1,
  [4943] = 4,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(616), 1,
      anon_sym_COMMA,
    ACTIONS(619), 1,
      anon_sym_RBRACK,
    STATE(191), 1,
      aux_sym_field_options_repeat1,
  [4956] = 4,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(621), 1,
      anon_sym_SEMI,
    ACTIONS(623), 1,
      anon_sym_COMMA,
    STATE(192), 1,
      aux_sym_reserved_field_names_repeat1,
  [4969] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(495), 3,
      anon_sym_RBRACE,
      anon_sym_LBRACK,
      sym_identifier,
  [4978] = 4,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(589), 1,
      anon_sym_COMMA,
    ACTIONS(626), 1,
      anon_sym_RBRACK,
    STATE(203), 1,
      aux_sym_enum_field_repeat1,
  [4991] = 4,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(598), 1,
      anon_sym_COMMA,
    ACTIONS(628), 1,
      anon_sym_RBRACK,
    STATE(187), 1,
      aux_sym_block_lit_repeat1,
  [5004] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(630), 3,
      anon_sym_RBRACE,
      anon_sym_LBRACK,
      sym_identifier,
  [5013] = 4,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(341), 1,
      anon_sym_RBRACK,
    ACTIONS(598), 1,
      anon_sym_COMMA,
    STATE(213), 1,
      aux_sym_block_lit_repeat1,
  [5026] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(507), 3,
      anon_sym_RBRACE,
      anon_sym_LBRACK,
      sym_identifier,
  [5035] = 4,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(632), 1,
      anon_sym_COMMA,
    ACTIONS(635), 1,
      anon_sym_RBRACK,
    STATE(199), 1,
      aux_sym_block_lit_repeat1,
  [5048] = 4,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(341), 1,
      anon_sym_RBRACK,
    ACTIONS(598), 1,
      anon_sym_COMMA,
    STATE(199), 1,
      aux_sym_block_lit_repeat1,
  [5061] = 4,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(589), 1,
      anon_sym_COMMA,
    ACTIONS(637), 1,
      anon_sym_RBRACK,
    STATE(180), 1,
      aux_sym_enum_field_repeat1,
  [5074] = 4,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(329), 1,
      anon_sym_RBRACK,
    ACTIONS(598), 1,
      anon_sym_COMMA,
    STATE(182), 1,
      aux_sym_block_lit_repeat1,
  [5087] = 4,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(589), 1,
      anon_sym_COMMA,
    ACTIONS(637), 1,
      anon_sym_RBRACK,
    STATE(181), 1,
      aux_sym_enum_field_repeat1,
  [5100] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(511), 3,
      anon_sym_RBRACE,
      anon_sym_LBRACK,
      sym_identifier,
  [5109] = 4,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(461), 1,
      anon_sym_LPAREN,
    ACTIONS(463), 1,
      sym_identifier,
    STATE(344), 1,
      sym__option_name,
  [5122] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(481), 3,
      anon_sym_RBRACE,
      anon_sym_LBRACK,
      sym_identifier,
  [5131] = 4,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(606), 1,
      anon_sym_COMMA,
    ACTIONS(639), 1,
      anon_sym_SEMI,
    STATE(192), 1,
      aux_sym_reserved_field_names_repeat1,
  [5144] = 4,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(366), 1,
      anon_sym_DOT,
    ACTIONS(641), 1,
      anon_sym_EQ,
    STATE(190), 1,
      aux_sym__option_name_repeat1,
  [5157] = 4,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(587), 1,
      anon_sym_COMMA,
    ACTIONS(643), 1,
      anon_sym_SEMI,
    STATE(217), 1,
      aux_sym_ranges_repeat1,
  [5170] = 4,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(600), 1,
      anon_sym_COMMA,
    ACTIONS(645), 1,
      anon_sym_RBRACK,
    STATE(184), 1,
      aux_sym_field_options_repeat1,
  [5183] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(467), 3,
      anon_sym_RBRACE,
      anon_sym_LBRACK,
      sym_identifier,
  [5192] = 4,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(366), 1,
      anon_sym_DOT,
    ACTIONS(647), 1,
      anon_sym_EQ,
    STATE(78), 1,
      aux_sym__option_name_repeat1,
  [5205] = 4,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(598), 1,
      anon_sym_COMMA,
    ACTIONS(628), 1,
      anon_sym_RBRACK,
    STATE(199), 1,
      aux_sym_block_lit_repeat1,
  [5218] = 4,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(366), 1,
      anon_sym_DOT,
    ACTIONS(649), 1,
      anon_sym_EQ,
    STATE(212), 1,
      aux_sym__option_name_repeat1,
  [5231] = 4,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(461), 1,
      anon_sym_LPAREN,
    ACTIONS(463), 1,
      sym_identifier,
    STATE(338), 1,
      sym__option_name,
  [5244] = 4,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(461), 1,
      anon_sym_LPAREN,
    ACTIONS(463), 1,
      sym_identifier,
    STATE(339), 1,
      sym__option_name,
  [5257] = 4,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(651), 1,
      anon_sym_SEMI,
    ACTIONS(653), 1,
      anon_sym_COMMA,
    STATE(217), 1,
      aux_sym_ranges_repeat1,
  [5270] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(656), 1,
      anon_sym_SEMI,
    ACTIONS(658), 1,
      anon_sym_LBRACK,
  [5280] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(660), 1,
      anon_sym_SEMI,
    ACTIONS(662), 1,
      anon_sym_LBRACK,
  [5290] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(621), 2,
      anon_sym_SEMI,
      anon_sym_COMMA,
  [5298] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(664), 1,
      sym_identifier,
    STATE(247), 1,
      sym_enum_name,
  [5308] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(666), 2,
      anon_sym_COMMA,
      anon_sym_RBRACK,
  [5316] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(596), 2,
      anon_sym_COMMA,
      anon_sym_RBRACK,
  [5324] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(668), 1,
      sym_identifier,
    STATE(311), 1,
      sym_service_name,
  [5334] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(670), 1,
      sym_identifier,
    STATE(237), 1,
      aux_sym_message_or_enum_type_repeat1,
  [5344] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(672), 1,
      sym_identifier,
    STATE(300), 1,
      sym_full_ident,
  [5354] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(664), 1,
      sym_identifier,
    STATE(243), 1,
      sym_enum_name,
  [5364] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(674), 1,
      sym_identifier,
    STATE(262), 1,
      sym_message_name,
  [5374] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(651), 2,
      anon_sym_SEMI,
      anon_sym_COMMA,
  [5382] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(676), 2,
      anon_sym_SEMI,
      anon_sym_COMMA,
  [5390] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(678), 1,
      anon_sym_SEMI,
    ACTIONS(680), 1,
      anon_sym_LBRACK,
  [5400] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(682), 2,
      anon_sym_COMMA,
      anon_sym_RBRACK,
  [5408] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(619), 2,
      anon_sym_COMMA,
      anon_sym_RBRACK,
  [5416] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(684), 1,
      anon_sym_LBRACE,
    STATE(14), 1,
      sym_message_body,
  [5426] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(686), 1,
      anon_sym_SEMI,
    ACTIONS(688), 1,
      anon_sym_LBRACK,
  [5436] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(674), 1,
      sym_identifier,
    STATE(277), 1,
      sym_message_name,
  [5446] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(690), 1,
      sym_identifier,
    STATE(246), 1,
      aux_sym_message_or_enum_type_repeat1,
  [5456] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(692), 1,
      anon_sym_SEMI,
    ACTIONS(694), 1,
      anon_sym_LBRACE,
  [5466] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(674), 1,
      sym_identifier,
    STATE(321), 1,
      sym_message_name,
  [5476] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(433), 1,
      anon_sym_SEMI,
    ACTIONS(696), 1,
      anon_sym_LBRACE,
  [5486] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(698), 2,
      anon_sym_GT,
      sym_identifier,
  [5494] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(700), 1,
      sym_identifier,
    STATE(297), 1,
      sym_rpc_name,
  [5504] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(702), 1,
      anon_sym_LBRACE,
    STATE(79), 1,
      sym_enum_body,
  [5514] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(704), 1,
      anon_sym_LBRACE,
    STATE(80), 1,
      sym_message_body,
  [5524] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(706), 2,
      anon_sym_DQUOTEproto3_DQUOTE,
      anon_sym_DQUOTEproto2_DQUOTE,
  [5532] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(708), 1,
      sym_identifier,
    STATE(246), 1,
      aux_sym_message_or_enum_type_repeat1,
  [5542] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(702), 1,
      anon_sym_LBRACE,
    STATE(74), 1,
      sym_enum_body,
  [5552] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(674), 1,
      sym_identifier,
    STATE(244), 1,
      sym_message_name,
  [5562] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(672), 1,
      sym_identifier,
    STATE(333), 1,
      sym_full_ident,
  [5572] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(672), 1,
      sym_identifier,
    STATE(279), 1,
      sym_full_ident,
  [5582] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(635), 2,
      anon_sym_COMMA,
      anon_sym_RBRACK,
  [5590] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(711), 2,
      anon_sym_EQ,
      anon_sym_LBRACE,
  [5598] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(684), 1,
      anon_sym_LBRACE,
    STATE(11), 1,
      sym_message_body,
  [5608] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(713), 1,
      anon_sym_enum,
    ACTIONS(715), 1,
      anon_sym_message,
  [5618] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(672), 1,
      sym_identifier,
    STATE(268), 1,
      sym_full_ident,
  [5628] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(717), 1,
      anon_sym_SEMI,
    ACTIONS(719), 1,
      anon_sym_LBRACK,
  [5638] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(721), 1,
      anon_sym_LBRACE,
    STATE(21), 1,
      sym_enum_body,
  [5648] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(684), 1,
      anon_sym_LBRACE,
    STATE(22), 1,
      sym_message_body,
  [5658] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(684), 1,
      anon_sym_LBRACE,
    STATE(23), 1,
      sym_message_body,
  [5668] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(721), 1,
      anon_sym_LBRACE,
    STATE(24), 1,
      sym_enum_body,
  [5678] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(684), 1,
      anon_sym_LBRACE,
    STATE(25), 1,
      sym_message_body,
  [5688] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(704), 1,
      anon_sym_LBRACE,
    STATE(70), 1,
      sym_message_body,
  [5698] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(664), 1,
      sym_identifier,
    STATE(257), 1,
      sym_enum_name,
  [5708] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(674), 1,
      sym_identifier,
    STATE(258), 1,
      sym_message_name,
  [5718] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(672), 1,
      sym_identifier,
    STATE(259), 1,
      sym_full_ident,
  [5728] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(664), 1,
      sym_identifier,
    STATE(260), 1,
      sym_enum_name,
  [5738] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(674), 1,
      sym_identifier,
    STATE(261), 1,
      sym_message_name,
  [5748] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(704), 1,
      anon_sym_LBRACE,
    STATE(75), 1,
      sym_message_body,
  [5758] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(723), 1,
      anon_sym_SEMI,
    ACTIONS(725), 1,
      anon_sym_LBRACK,
  [5768] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(727), 1,
      anon_sym_enum,
    ACTIONS(729), 1,
      anon_sym_message,
  [5778] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(670), 1,
      sym_identifier,
    STATE(246), 1,
      aux_sym_message_or_enum_type_repeat1,
  [5788] = 3,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(435), 1,
      anon_sym_SEMI,
    ACTIONS(731), 1,
      anon_sym_LBRACE,
  [5798] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(733), 1,
      anon_sym_RBRACK,
  [5805] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(735), 1,
      anon_sym_GT,
  [5812] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(737), 1,
      anon_sym_EQ,
  [5819] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(739), 1,
      sym_identifier,
  [5826] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(741), 1,
      anon_sym_EQ,
  [5833] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(743), 1,
      anon_sym_RPAREN,
  [5840] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(745), 1,
      anon_sym_RPAREN,
  [5847] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(747), 1,
      anon_sym_SEMI,
  [5854] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(749), 1,
      anon_sym_LBRACE,
  [5861] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(543), 1,
      anon_sym_DOT,
  [5868] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(751), 1,
      anon_sym_EQ,
  [5875] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(753), 1,
      anon_sym_SEMI,
  [5882] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(755), 1,
      anon_sym_SEMI,
  [5889] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(757), 1,
      anon_sym_SEMI,
  [5896] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(759), 1,
      anon_sym_SEMI,
  [5903] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(761), 1,
      anon_sym_RPAREN,
  [5910] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(763), 1,
      sym_identifier,
  [5917] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(765), 1,
      anon_sym_EQ,
  [5924] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(767), 1,
      anon_sym_LPAREN,
  [5931] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(769), 1,
      sym_identifier,
  [5938] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(771), 1,
      anon_sym_returns,
  [5945] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(773), 1,
      anon_sym_LBRACE,
  [5952] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(775), 1,
      anon_sym_SEMI,
  [5959] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(777), 1,
      anon_sym_LPAREN,
  [5966] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(779), 1,
      anon_sym_LPAREN,
  [5973] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(781), 1,
      anon_sym_RBRACK,
  [5980] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(783), 1,
      sym_identifier,
  [5987] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(785), 1,
      anon_sym_RBRACK,
  [5994] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(787), 1,
      anon_sym_EQ,
  [6001] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(789), 1,
      anon_sym_SEMI,
  [6008] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(791), 1,
      anon_sym_SEMI,
  [6015] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(793), 1,
      anon_sym_SEMI,
  [6022] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(795), 1,
      anon_sym_RBRACK,
  [6029] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(797), 1,
      sym_reserved_identifier,
  [6036] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(799), 1,
      anon_sym_SEMI,
  [6043] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(801), 1,
      anon_sym_SEMI,
  [6050] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(803), 1,
      anon_sym_LBRACE,
  [6057] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(805), 1,
      anon_sym_EQ,
  [6064] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(807), 1,
      anon_sym_LBRACE,
  [6071] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(809), 1,
      anon_sym_returns,
  [6078] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(811), 1,
      anon_sym_SEMI,
  [6085] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(813), 1,
      anon_sym_LPAREN,
  [6092] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(815), 1,
      sym_identifier,
  [6099] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(817), 1,
      anon_sym_EQ,
  [6106] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(819), 1,
      anon_sym_EQ,
  [6113] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(821), 1,
      anon_sym_RPAREN,
  [6120] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(823), 1,
      ts_builtin_sym_end,
  [6127] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(825), 1,
      sym_identifier,
  [6134] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(827), 1,
      anon_sym_EQ,
  [6141] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(829), 1,
      anon_sym_SEMI,
  [6148] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(831), 1,
      anon_sym_EQ,
  [6155] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(833), 1,
      anon_sym_SEMI,
  [6162] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(835), 1,
      anon_sym_SEMI,
  [6169] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(837), 1,
      anon_sym_SEMI,
  [6176] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(839), 1,
      anon_sym_SEMI,
  [6183] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(841), 1,
      anon_sym_EQ,
  [6190] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(843), 1,
      anon_sym_EQ,
  [6197] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(845), 1,
      anon_sym_SEMI,
  [6204] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(847), 1,
      anon_sym_RBRACK,
  [6211] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(849), 1,
      anon_sym_RBRACK,
  [6218] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(851), 1,
      anon_sym_SEMI,
  [6225] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(853), 1,
      anon_sym_COMMA,
  [6232] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(855), 1,
      anon_sym_COMMA,
  [6239] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(857), 1,
      sym_identifier,
  [6246] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(859), 1,
      anon_sym_RPAREN,
  [6253] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(861), 1,
      anon_sym_EQ,
  [6260] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(863), 1,
      anon_sym_EQ,
  [6267] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(865), 1,
      anon_sym_EQ,
  [6274] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(867), 1,
      anon_sym_RPAREN,
  [6281] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(869), 1,
      sym_identifier,
  [6288] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(871), 1,
      anon_sym_LT,
  [6295] = 2,
    ACTIONS(3), 1,
      sym_comment,
    ACTIONS(873), 1,
      anon_sym_EQ,
};

static const uint32_t ts_small_parse_table_map[] = {
  [SMALL_STATE(2)] = 0,
  [SMALL_STATE(3)] = 94,
  [SMALL_STATE(4)] = 188,
  [SMALL_STATE(5)] = 282,
  [SMALL_STATE(6)] = 376,
  [SMALL_STATE(7)] = 470,
  [SMALL_STATE(8)] = 511,
  [SMALL_STATE(9)] = 552,
  [SMALL_STATE(10)] = 593,
  [SMALL_STATE(11)] = 634,
  [SMALL_STATE(12)] = 675,
  [SMALL_STATE(13)] = 716,
  [SMALL_STATE(14)] = 757,
  [SMALL_STATE(15)] = 798,
  [SMALL_STATE(16)] = 839,
  [SMALL_STATE(17)] = 880,
  [SMALL_STATE(18)] = 921,
  [SMALL_STATE(19)] = 962,
  [SMALL_STATE(20)] = 1003,
  [SMALL_STATE(21)] = 1044,
  [SMALL_STATE(22)] = 1085,
  [SMALL_STATE(23)] = 1126,
  [SMALL_STATE(24)] = 1167,
  [SMALL_STATE(25)] = 1208,
  [SMALL_STATE(26)] = 1249,
  [SMALL_STATE(27)] = 1290,
  [SMALL_STATE(28)] = 1331,
  [SMALL_STATE(29)] = 1372,
  [SMALL_STATE(30)] = 1413,
  [SMALL_STATE(31)] = 1454,
  [SMALL_STATE(32)] = 1495,
  [SMALL_STATE(33)] = 1546,
  [SMALL_STATE(34)] = 1597,
  [SMALL_STATE(35)] = 1648,
  [SMALL_STATE(36)] = 1690,
  [SMALL_STATE(37)] = 1720,
  [SMALL_STATE(38)] = 1751,
  [SMALL_STATE(39)] = 1790,
  [SMALL_STATE(40)] = 1819,
  [SMALL_STATE(41)] = 1872,
  [SMALL_STATE(42)] = 1925,
  [SMALL_STATE(43)] = 1971,
  [SMALL_STATE(44)] = 2007,
  [SMALL_STATE(45)] = 2053,
  [SMALL_STATE(46)] = 2099,
  [SMALL_STATE(47)] = 2149,
  [SMALL_STATE(48)] = 2199,
  [SMALL_STATE(49)] = 2249,
  [SMALL_STATE(50)] = 2285,
  [SMALL_STATE(51)] = 2335,
  [SMALL_STATE(52)] = 2385,
  [SMALL_STATE(53)] = 2413,
  [SMALL_STATE(54)] = 2459,
  [SMALL_STATE(55)] = 2509,
  [SMALL_STATE(56)] = 2537,
  [SMALL_STATE(57)] = 2565,
  [SMALL_STATE(58)] = 2612,
  [SMALL_STATE(59)] = 2659,
  [SMALL_STATE(60)] = 2706,
  [SMALL_STATE(61)] = 2753,
  [SMALL_STATE(62)] = 2800,
  [SMALL_STATE(63)] = 2847,
  [SMALL_STATE(64)] = 2894,
  [SMALL_STATE(65)] = 2913,
  [SMALL_STATE(66)] = 2934,
  [SMALL_STATE(67)] = 2953,
  [SMALL_STATE(68)] = 2970,
  [SMALL_STATE(69)] = 2987,
  [SMALL_STATE(70)] = 3004,
  [SMALL_STATE(71)] = 3021,
  [SMALL_STATE(72)] = 3038,
  [SMALL_STATE(73)] = 3055,
  [SMALL_STATE(74)] = 3072,
  [SMALL_STATE(75)] = 3089,
  [SMALL_STATE(76)] = 3106,
  [SMALL_STATE(77)] = 3123,
  [SMALL_STATE(78)] = 3140,
  [SMALL_STATE(79)] = 3161,
  [SMALL_STATE(80)] = 3178,
  [SMALL_STATE(81)] = 3195,
  [SMALL_STATE(82)] = 3212,
  [SMALL_STATE(83)] = 3229,
  [SMALL_STATE(84)] = 3246,
  [SMALL_STATE(85)] = 3266,
  [SMALL_STATE(86)] = 3292,
  [SMALL_STATE(87)] = 3318,
  [SMALL_STATE(88)] = 3344,
  [SMALL_STATE(89)] = 3370,
  [SMALL_STATE(90)] = 3390,
  [SMALL_STATE(91)] = 3406,
  [SMALL_STATE(92)] = 3432,
  [SMALL_STATE(93)] = 3453,
  [SMALL_STATE(94)] = 3474,
  [SMALL_STATE(95)] = 3488,
  [SMALL_STATE(96)] = 3512,
  [SMALL_STATE(97)] = 3534,
  [SMALL_STATE(98)] = 3548,
  [SMALL_STATE(99)] = 3572,
  [SMALL_STATE(100)] = 3594,
  [SMALL_STATE(101)] = 3616,
  [SMALL_STATE(102)] = 3637,
  [SMALL_STATE(103)] = 3655,
  [SMALL_STATE(104)] = 3673,
  [SMALL_STATE(105)] = 3691,
  [SMALL_STATE(106)] = 3709,
  [SMALL_STATE(107)] = 3727,
  [SMALL_STATE(108)] = 3745,
  [SMALL_STATE(109)] = 3763,
  [SMALL_STATE(110)] = 3775,
  [SMALL_STATE(111)] = 3787,
  [SMALL_STATE(112)] = 3799,
  [SMALL_STATE(113)] = 3811,
  [SMALL_STATE(114)] = 3831,
  [SMALL_STATE(115)] = 3843,
  [SMALL_STATE(116)] = 3855,
  [SMALL_STATE(117)] = 3872,
  [SMALL_STATE(118)] = 3891,
  [SMALL_STATE(119)] = 3904,
  [SMALL_STATE(120)] = 3921,
  [SMALL_STATE(121)] = 3940,
  [SMALL_STATE(122)] = 3953,
  [SMALL_STATE(123)] = 3972,
  [SMALL_STATE(124)] = 3985,
  [SMALL_STATE(125)] = 3998,
  [SMALL_STATE(126)] = 4017,
  [SMALL_STATE(127)] = 4034,
  [SMALL_STATE(128)] = 4047,
  [SMALL_STATE(129)] = 4058,
  [SMALL_STATE(130)] = 4075,
  [SMALL_STATE(131)] = 4092,
  [SMALL_STATE(132)] = 4105,
  [SMALL_STATE(133)] = 4122,
  [SMALL_STATE(134)] = 4135,
  [SMALL_STATE(135)] = 4148,
  [SMALL_STATE(136)] = 4165,
  [SMALL_STATE(137)] = 4178,
  [SMALL_STATE(138)] = 4197,
  [SMALL_STATE(139)] = 4210,
  [SMALL_STATE(140)] = 4223,
  [SMALL_STATE(141)] = 4240,
  [SMALL_STATE(142)] = 4253,
  [SMALL_STATE(143)] = 4266,
  [SMALL_STATE(144)] = 4283,
  [SMALL_STATE(145)] = 4300,
  [SMALL_STATE(146)] = 4317,
  [SMALL_STATE(147)] = 4330,
  [SMALL_STATE(148)] = 4349,
  [SMALL_STATE(149)] = 4362,
  [SMALL_STATE(150)] = 4379,
  [SMALL_STATE(151)] = 4398,
  [SMALL_STATE(152)] = 4417,
  [SMALL_STATE(153)] = 4431,
  [SMALL_STATE(154)] = 4447,
  [SMALL_STATE(155)] = 4463,
  [SMALL_STATE(156)] = 4479,
  [SMALL_STATE(157)] = 4495,
  [SMALL_STATE(158)] = 4507,
  [SMALL_STATE(159)] = 4523,
  [SMALL_STATE(160)] = 4537,
  [SMALL_STATE(161)] = 4551,
  [SMALL_STATE(162)] = 4567,
  [SMALL_STATE(163)] = 4583,
  [SMALL_STATE(164)] = 4599,
  [SMALL_STATE(165)] = 4611,
  [SMALL_STATE(166)] = 4627,
  [SMALL_STATE(167)] = 4643,
  [SMALL_STATE(168)] = 4653,
  [SMALL_STATE(169)] = 4663,
  [SMALL_STATE(170)] = 4673,
  [SMALL_STATE(171)] = 4683,
  [SMALL_STATE(172)] = 4693,
  [SMALL_STATE(173)] = 4709,
  [SMALL_STATE(174)] = 4723,
  [SMALL_STATE(175)] = 4739,
  [SMALL_STATE(176)] = 4753,
  [SMALL_STATE(177)] = 4765,
  [SMALL_STATE(178)] = 4779,
  [SMALL_STATE(179)] = 4793,
  [SMALL_STATE(180)] = 4806,
  [SMALL_STATE(181)] = 4819,
  [SMALL_STATE(182)] = 4832,
  [SMALL_STATE(183)] = 4845,
  [SMALL_STATE(184)] = 4858,
  [SMALL_STATE(185)] = 4871,
  [SMALL_STATE(186)] = 4880,
  [SMALL_STATE(187)] = 4893,
  [SMALL_STATE(188)] = 4906,
  [SMALL_STATE(189)] = 4919,
  [SMALL_STATE(190)] = 4930,
  [SMALL_STATE(191)] = 4943,
  [SMALL_STATE(192)] = 4956,
  [SMALL_STATE(193)] = 4969,
  [SMALL_STATE(194)] = 4978,
  [SMALL_STATE(195)] = 4991,
  [SMALL_STATE(196)] = 5004,
  [SMALL_STATE(197)] = 5013,
  [SMALL_STATE(198)] = 5026,
  [SMALL_STATE(199)] = 5035,
  [SMALL_STATE(200)] = 5048,
  [SMALL_STATE(201)] = 5061,
  [SMALL_STATE(202)] = 5074,
  [SMALL_STATE(203)] = 5087,
  [SMALL_STATE(204)] = 5100,
  [SMALL_STATE(205)] = 5109,
  [SMALL_STATE(206)] = 5122,
  [SMALL_STATE(207)] = 5131,
  [SMALL_STATE(208)] = 5144,
  [SMALL_STATE(209)] = 5157,
  [SMALL_STATE(210)] = 5170,
  [SMALL_STATE(211)] = 5183,
  [SMALL_STATE(212)] = 5192,
  [SMALL_STATE(213)] = 5205,
  [SMALL_STATE(214)] = 5218,
  [SMALL_STATE(215)] = 5231,
  [SMALL_STATE(216)] = 5244,
  [SMALL_STATE(217)] = 5257,
  [SMALL_STATE(218)] = 5270,
  [SMALL_STATE(219)] = 5280,
  [SMALL_STATE(220)] = 5290,
  [SMALL_STATE(221)] = 5298,
  [SMALL_STATE(222)] = 5308,
  [SMALL_STATE(223)] = 5316,
  [SMALL_STATE(224)] = 5324,
  [SMALL_STATE(225)] = 5334,
  [SMALL_STATE(226)] = 5344,
  [SMALL_STATE(227)] = 5354,
  [SMALL_STATE(228)] = 5364,
  [SMALL_STATE(229)] = 5374,
  [SMALL_STATE(230)] = 5382,
  [SMALL_STATE(231)] = 5390,
  [SMALL_STATE(232)] = 5400,
  [SMALL_STATE(233)] = 5408,
  [SMALL_STATE(234)] = 5416,
  [SMALL_STATE(235)] = 5426,
  [SMALL_STATE(236)] = 5436,
  [SMALL_STATE(237)] = 5446,
  [SMALL_STATE(238)] = 5456,
  [SMALL_STATE(239)] = 5466,
  [SMALL_STATE(240)] = 5476,
  [SMALL_STATE(241)] = 5486,
  [SMALL_STATE(242)] = 5494,
  [SMALL_STATE(243)] = 5504,
  [SMALL_STATE(244)] = 5514,
  [SMALL_STATE(245)] = 5524,
  [SMALL_STATE(246)] = 5532,
  [SMALL_STATE(247)] = 5542,
  [SMALL_STATE(248)] = 5552,
  [SMALL_STATE(249)] = 5562,
  [SMALL_STATE(250)] = 5572,
  [SMALL_STATE(251)] = 5582,
  [SMALL_STATE(252)] = 5590,
  [SMALL_STATE(253)] = 5598,
  [SMALL_STATE(254)] = 5608,
  [SMALL_STATE(255)] = 5618,
  [SMALL_STATE(256)] = 5628,
  [SMALL_STATE(257)] = 5638,
  [SMALL_STATE(258)] = 5648,
  [SMALL_STATE(259)] = 5658,
  [SMALL_STATE(260)] = 5668,
  [SMALL_STATE(261)] = 5678,
  [SMALL_STATE(262)] = 5688,
  [SMALL_STATE(263)] = 5698,
  [SMALL_STATE(264)] = 5708,
  [SMALL_STATE(265)] = 5718,
  [SMALL_STATE(266)] = 5728,
  [SMALL_STATE(267)] = 5738,
  [SMALL_STATE(268)] = 5748,
  [SMALL_STATE(269)] = 5758,
  [SMALL_STATE(270)] = 5768,
  [SMALL_STATE(271)] = 5778,
  [SMALL_STATE(272)] = 5788,
  [SMALL_STATE(273)] = 5798,
  [SMALL_STATE(274)] = 5805,
  [SMALL_STATE(275)] = 5812,
  [SMALL_STATE(276)] = 5819,
  [SMALL_STATE(277)] = 5826,
  [SMALL_STATE(278)] = 5833,
  [SMALL_STATE(279)] = 5840,
  [SMALL_STATE(280)] = 5847,
  [SMALL_STATE(281)] = 5854,
  [SMALL_STATE(282)] = 5861,
  [SMALL_STATE(283)] = 5868,
  [SMALL_STATE(284)] = 5875,
  [SMALL_STATE(285)] = 5882,
  [SMALL_STATE(286)] = 5889,
  [SMALL_STATE(287)] = 5896,
  [SMALL_STATE(288)] = 5903,
  [SMALL_STATE(289)] = 5910,
  [SMALL_STATE(290)] = 5917,
  [SMALL_STATE(291)] = 5924,
  [SMALL_STATE(292)] = 5931,
  [SMALL_STATE(293)] = 5938,
  [SMALL_STATE(294)] = 5945,
  [SMALL_STATE(295)] = 5952,
  [SMALL_STATE(296)] = 5959,
  [SMALL_STATE(297)] = 5966,
  [SMALL_STATE(298)] = 5973,
  [SMALL_STATE(299)] = 5980,
  [SMALL_STATE(300)] = 5987,
  [SMALL_STATE(301)] = 5994,
  [SMALL_STATE(302)] = 6001,
  [SMALL_STATE(303)] = 6008,
  [SMALL_STATE(304)] = 6015,
  [SMALL_STATE(305)] = 6022,
  [SMALL_STATE(306)] = 6029,
  [SMALL_STATE(307)] = 6036,
  [SMALL_STATE(308)] = 6043,
  [SMALL_STATE(309)] = 6050,
  [SMALL_STATE(310)] = 6057,
  [SMALL_STATE(311)] = 6064,
  [SMALL_STATE(312)] = 6071,
  [SMALL_STATE(313)] = 6078,
  [SMALL_STATE(314)] = 6085,
  [SMALL_STATE(315)] = 6092,
  [SMALL_STATE(316)] = 6099,
  [SMALL_STATE(317)] = 6106,
  [SMALL_STATE(318)] = 6113,
  [SMALL_STATE(319)] = 6120,
  [SMALL_STATE(320)] = 6127,
  [SMALL_STATE(321)] = 6134,
  [SMALL_STATE(322)] = 6141,
  [SMALL_STATE(323)] = 6148,
  [SMALL_STATE(324)] = 6155,
  [SMALL_STATE(325)] = 6162,
  [SMALL_STATE(326)] = 6169,
  [SMALL_STATE(327)] = 6176,
  [SMALL_STATE(328)] = 6183,
  [SMALL_STATE(329)] = 6190,
  [SMALL_STATE(330)] = 6197,
  [SMALL_STATE(331)] = 6204,
  [SMALL_STATE(332)] = 6211,
  [SMALL_STATE(333)] = 6218,
  [SMALL_STATE(334)] = 6225,
  [SMALL_STATE(335)] = 6232,
  [SMALL_STATE(336)] = 6239,
  [SMALL_STATE(337)] = 6246,
  [SMALL_STATE(338)] = 6253,
  [SMALL_STATE(339)] = 6260,
  [SMALL_STATE(340)] = 6267,
  [SMALL_STATE(341)] = 6274,
  [SMALL_STATE(342)] = 6281,
  [SMALL_STATE(343)] = 6288,
  [SMALL_STATE(344)] = 6295,
};

static const TSParseActionEntry ts_parse_actions[] = {
  [0] = {.entry = {.count = 0, .reusable = false}},
  [1] = {.entry = {.count = 1, .reusable = false}}, RECOVER(),
  [3] = {.entry = {.count = 1, .reusable = true}}, SHIFT_EXTRA(),
  [5] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_source_file, 0, 0, 0),
  [7] = {.entry = {.count = 1, .reusable = true}}, SHIFT(66),
  [9] = {.entry = {.count = 1, .reusable = true}}, SHIFT(328),
  [11] = {.entry = {.count = 1, .reusable = true}}, SHIFT(316),
  [13] = {.entry = {.count = 1, .reusable = true}}, SHIFT(101),
  [15] = {.entry = {.count = 1, .reusable = true}}, SHIFT(205),
  [17] = {.entry = {.count = 1, .reusable = true}}, SHIFT(249),
  [19] = {.entry = {.count = 1, .reusable = true}}, SHIFT(254),
  [21] = {.entry = {.count = 1, .reusable = true}}, SHIFT(221),
  [23] = {.entry = {.count = 1, .reusable = true}}, SHIFT(228),
  [25] = {.entry = {.count = 1, .reusable = true}}, SHIFT(255),
  [27] = {.entry = {.count = 1, .reusable = true}}, SHIFT(224),
  [29] = {.entry = {.count = 1, .reusable = true}}, SHIFT(30),
  [31] = {.entry = {.count = 1, .reusable = false}}, SHIFT(216),
  [33] = {.entry = {.count = 1, .reusable = true}}, SHIFT(225),
  [35] = {.entry = {.count = 1, .reusable = false}}, SHIFT(270),
  [37] = {.entry = {.count = 1, .reusable = false}}, SHIFT(263),
  [39] = {.entry = {.count = 1, .reusable = true}}, SHIFT(82),
  [41] = {.entry = {.count = 1, .reusable = false}}, SHIFT(264),
  [43] = {.entry = {.count = 1, .reusable = false}}, SHIFT(265),
  [45] = {.entry = {.count = 1, .reusable = false}}, SHIFT(35),
  [47] = {.entry = {.count = 1, .reusable = false}}, SHIFT(38),
  [49] = {.entry = {.count = 1, .reusable = false}}, SHIFT(236),
  [51] = {.entry = {.count = 1, .reusable = false}}, SHIFT(336),
  [53] = {.entry = {.count = 1, .reusable = false}}, SHIFT(343),
  [55] = {.entry = {.count = 1, .reusable = false}}, SHIFT(241),
  [57] = {.entry = {.count = 1, .reusable = false}}, SHIFT(95),
  [59] = {.entry = {.count = 1, .reusable = false}}, SHIFT(113),
  [61] = {.entry = {.count = 1, .reusable = false}}, SHIFT(157),
  [63] = {.entry = {.count = 1, .reusable = true}}, SHIFT(69),
  [65] = {.entry = {.count = 2, .reusable = true}}, REDUCE(aux_sym_message_body_repeat1, 2, 0, 0), SHIFT_REPEAT(30),
  [68] = {.entry = {.count = 2, .reusable = false}}, REDUCE(aux_sym_message_body_repeat1, 2, 0, 0), SHIFT_REPEAT(216),
  [71] = {.entry = {.count = 2, .reusable = true}}, REDUCE(aux_sym_message_body_repeat1, 2, 0, 0), SHIFT_REPEAT(225),
  [74] = {.entry = {.count = 2, .reusable = false}}, REDUCE(aux_sym_message_body_repeat1, 2, 0, 0), SHIFT_REPEAT(270),
  [77] = {.entry = {.count = 2, .reusable = false}}, REDUCE(aux_sym_message_body_repeat1, 2, 0, 0), SHIFT_REPEAT(263),
  [80] = {.entry = {.count = 1, .reusable = true}}, REDUCE(aux_sym_message_body_repeat1, 2, 0, 0),
  [82] = {.entry = {.count = 2, .reusable = false}}, REDUCE(aux_sym_message_body_repeat1, 2, 0, 0), SHIFT_REPEAT(264),
  [85] = {.entry = {.count = 2, .reusable = false}}, REDUCE(aux_sym_message_body_repeat1, 2, 0, 0), SHIFT_REPEAT(265),
  [88] = {.entry = {.count = 2, .reusable = false}}, REDUCE(aux_sym_message_body_repeat1, 2, 0, 0), SHIFT_REPEAT(35),
  [91] = {.entry = {.count = 2, .reusable = false}}, REDUCE(aux_sym_message_body_repeat1, 2, 0, 0), SHIFT_REPEAT(38),
  [94] = {.entry = {.count = 2, .reusable = false}}, REDUCE(aux_sym_message_body_repeat1, 2, 0, 0), SHIFT_REPEAT(236),
  [97] = {.entry = {.count = 2, .reusable = false}}, REDUCE(aux_sym_message_body_repeat1, 2, 0, 0), SHIFT_REPEAT(336),
  [100] = {.entry = {.count = 2, .reusable = false}}, REDUCE(aux_sym_message_body_repeat1, 2, 0, 0), SHIFT_REPEAT(343),
  [103] = {.entry = {.count = 2, .reusable = false}}, REDUCE(aux_sym_message_body_repeat1, 2, 0, 0), SHIFT_REPEAT(241),
  [106] = {.entry = {.count = 2, .reusable = false}}, REDUCE(aux_sym_message_body_repeat1, 2, 0, 0), SHIFT_REPEAT(95),
  [109] = {.entry = {.count = 2, .reusable = false}}, REDUCE(aux_sym_message_body_repeat1, 2, 0, 0), SHIFT_REPEAT(113),
  [112] = {.entry = {.count = 2, .reusable = false}}, REDUCE(aux_sym_message_body_repeat1, 2, 0, 0), SHIFT_REPEAT(157),
  [115] = {.entry = {.count = 1, .reusable = true}}, SHIFT(28),
  [117] = {.entry = {.count = 1, .reusable = true}}, SHIFT(27),
  [119] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_enum_body, 3, 0, 0),
  [121] = {.entry = {.count = 1, .reusable = false}}, REDUCE(sym_enum_body, 3, 0, 0),
  [123] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_option, 5, 0, 0),
  [125] = {.entry = {.count = 1, .reusable = false}}, REDUCE(sym_option, 5, 0, 0),
  [127] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_extensions, 3, 0, 0),
  [129] = {.entry = {.count = 1, .reusable = false}}, REDUCE(sym_extensions, 3, 0, 0),
  [131] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_oneof, 4, 0, 0),
  [133] = {.entry = {.count = 1, .reusable = false}}, REDUCE(sym_oneof, 4, 0, 0),
  [135] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_group, 5, 0, 0),
  [137] = {.entry = {.count = 1, .reusable = false}}, REDUCE(sym_group, 5, 0, 0),
  [139] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_oneof, 5, 0, 0),
  [141] = {.entry = {.count = 1, .reusable = false}}, REDUCE(sym_oneof, 5, 0, 0),
  [143] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_field, 5, 0, 0),
  [145] = {.entry = {.count = 1, .reusable = false}}, REDUCE(sym_field, 5, 0, 0),
  [147] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_group, 6, 0, 0),
  [149] = {.entry = {.count = 1, .reusable = false}}, REDUCE(sym_group, 6, 0, 0),
  [151] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_field, 6, 0, 0),
  [153] = {.entry = {.count = 1, .reusable = false}}, REDUCE(sym_field, 6, 0, 0),
  [155] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_field, 7, 0, 0),
  [157] = {.entry = {.count = 1, .reusable = false}}, REDUCE(sym_field, 7, 0, 0),
  [159] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_field, 8, 0, 0),
  [161] = {.entry = {.count = 1, .reusable = false}}, REDUCE(sym_field, 8, 0, 0),
  [163] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_field, 10, 0, 0),
  [165] = {.entry = {.count = 1, .reusable = false}}, REDUCE(sym_field, 10, 0, 0),
  [167] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_map_field, 10, 0, 0),
  [169] = {.entry = {.count = 1, .reusable = false}}, REDUCE(sym_map_field, 10, 0, 0),
  [171] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_map_field, 13, 0, 0),
  [173] = {.entry = {.count = 1, .reusable = false}}, REDUCE(sym_map_field, 13, 0, 0),
  [175] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_enum, 3, 0, 0),
  [177] = {.entry = {.count = 1, .reusable = false}}, REDUCE(sym_enum, 3, 0, 0),
  [179] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_message, 3, 0, 0),
  [181] = {.entry = {.count = 1, .reusable = false}}, REDUCE(sym_message, 3, 0, 0),
  [183] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_extend, 3, 0, 0),
  [185] = {.entry = {.count = 1, .reusable = false}}, REDUCE(sym_extend, 3, 0, 0),
  [187] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_enum, 4, 0, 0),
  [189] = {.entry = {.count = 1, .reusable = false}}, REDUCE(sym_enum, 4, 0, 0),
  [191] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_message, 4, 0, 0),
  [193] = {.entry = {.count = 1, .reusable = false}}, REDUCE(sym_message, 4, 0, 0),
  [195] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_enum_body, 2, 0, 0),
  [197] = {.entry = {.count = 1, .reusable = false}}, REDUCE(sym_enum_body, 2, 0, 0),
  [199] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_message_body, 2, 0, 0),
  [201] = {.entry = {.count = 1, .reusable = false}}, REDUCE(sym_message_body, 2, 0, 0),
  [203] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_message_body, 3, 0, 0),
  [205] = {.entry = {.count = 1, .reusable = false}}, REDUCE(sym_message_body, 3, 0, 0),
  [207] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_reserved, 3, 0, 0),
  [209] = {.entry = {.count = 1, .reusable = false}}, REDUCE(sym_reserved, 3, 0, 0),
  [211] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_empty_statement, 1, 0, 0),
  [213] = {.entry = {.count = 1, .reusable = false}}, REDUCE(sym_empty_statement, 1, 0, 0),
  [215] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_field, 9, 0, 0),
  [217] = {.entry = {.count = 1, .reusable = false}}, REDUCE(sym_field, 9, 0, 0),
  [219] = {.entry = {.count = 1, .reusable = true}}, SHIFT(55),
  [221] = {.entry = {.count = 1, .reusable = false}}, SHIFT(188),
  [223] = {.entry = {.count = 1, .reusable = true}}, SHIFT(10),
  [225] = {.entry = {.count = 2, .reusable = true}}, REDUCE(aux_sym_oneof_repeat1, 2, 0, 0), SHIFT_REPEAT(55),
  [228] = {.entry = {.count = 2, .reusable = false}}, REDUCE(aux_sym_oneof_repeat1, 2, 0, 0), SHIFT_REPEAT(188),
  [231] = {.entry = {.count = 2, .reusable = true}}, REDUCE(aux_sym_oneof_repeat1, 2, 0, 0), SHIFT_REPEAT(225),
  [234] = {.entry = {.count = 1, .reusable = true}}, REDUCE(aux_sym_oneof_repeat1, 2, 0, 0),
  [236] = {.entry = {.count = 2, .reusable = false}}, REDUCE(aux_sym_oneof_repeat1, 2, 0, 0), SHIFT_REPEAT(241),
  [239] = {.entry = {.count = 2, .reusable = false}}, REDUCE(aux_sym_oneof_repeat1, 2, 0, 0), SHIFT_REPEAT(157),
  [242] = {.entry = {.count = 1, .reusable = true}}, SHIFT(12),
  [244] = {.entry = {.count = 1, .reusable = false}}, SHIFT(43),
  [246] = {.entry = {.count = 1, .reusable = false}}, SHIFT(239),
  [248] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_field_number, 1, 0, 0),
  [250] = {.entry = {.count = 1, .reusable = false}}, REDUCE(sym_field_number, 1, 0, 0),
  [252] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_oneof_field, 4, 0, 0),
  [254] = {.entry = {.count = 1, .reusable = false}}, REDUCE(sym_oneof_field, 4, 0, 0),
  [256] = {.entry = {.count = 1, .reusable = true}}, SHIFT(125),
  [258] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_int_lit, 1, 0, 0),
  [260] = {.entry = {.count = 1, .reusable = false}}, REDUCE(sym_int_lit, 1, 0, 0),
  [262] = {.entry = {.count = 1, .reusable = true}}, SHIFT(153),
  [264] = {.entry = {.count = 1, .reusable = true}}, SHIFT(144),
  [266] = {.entry = {.count = 1, .reusable = true}}, SHIFT(50),
  [268] = {.entry = {.count = 1, .reusable = true}}, SHIFT(51),
  [270] = {.entry = {.count = 1, .reusable = false}}, SHIFT(89),
  [272] = {.entry = {.count = 1, .reusable = false}}, SHIFT(110),
  [274] = {.entry = {.count = 1, .reusable = false}}, SHIFT(128),
  [276] = {.entry = {.count = 1, .reusable = true}}, SHIFT(128),
  [278] = {.entry = {.count = 1, .reusable = false}}, SHIFT(112),
  [280] = {.entry = {.count = 1, .reusable = true}}, SHIFT(173),
  [282] = {.entry = {.count = 1, .reusable = true}}, SHIFT(152),
  [284] = {.entry = {.count = 1, .reusable = true}}, SHIFT(46),
  [286] = {.entry = {.count = 1, .reusable = true}}, SHIFT(48),
  [288] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_source_file, 2, 0, 0),
  [290] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_source_file, 1, 0, 0),
  [292] = {.entry = {.count = 1, .reusable = true}}, REDUCE(aux_sym_source_file_repeat1, 2, 0, 0),
  [294] = {.entry = {.count = 2, .reusable = true}}, REDUCE(aux_sym_source_file_repeat1, 2, 0, 0), SHIFT_REPEAT(66),
  [297] = {.entry = {.count = 2, .reusable = true}}, REDUCE(aux_sym_source_file_repeat1, 2, 0, 0), SHIFT_REPEAT(101),
  [300] = {.entry = {.count = 2, .reusable = true}}, REDUCE(aux_sym_source_file_repeat1, 2, 0, 0), SHIFT_REPEAT(205),
  [303] = {.entry = {.count = 2, .reusable = true}}, REDUCE(aux_sym_source_file_repeat1, 2, 0, 0), SHIFT_REPEAT(249),
  [306] = {.entry = {.count = 2, .reusable = true}}, REDUCE(aux_sym_source_file_repeat1, 2, 0, 0), SHIFT_REPEAT(254),
  [309] = {.entry = {.count = 2, .reusable = true}}, REDUCE(aux_sym_source_file_repeat1, 2, 0, 0), SHIFT_REPEAT(221),
  [312] = {.entry = {.count = 2, .reusable = true}}, REDUCE(aux_sym_source_file_repeat1, 2, 0, 0), SHIFT_REPEAT(228),
  [315] = {.entry = {.count = 2, .reusable = true}}, REDUCE(aux_sym_source_file_repeat1, 2, 0, 0), SHIFT_REPEAT(255),
  [318] = {.entry = {.count = 2, .reusable = true}}, REDUCE(aux_sym_source_file_repeat1, 2, 0, 0), SHIFT_REPEAT(224),
  [321] = {.entry = {.count = 1, .reusable = true}}, SHIFT(116),
  [323] = {.entry = {.count = 1, .reusable = true}}, SHIFT(141),
  [325] = {.entry = {.count = 1, .reusable = false}}, SHIFT(109),
  [327] = {.entry = {.count = 1, .reusable = true}}, SHIFT(109),
  [329] = {.entry = {.count = 1, .reusable = true}}, SHIFT(127),
  [331] = {.entry = {.count = 1, .reusable = true}}, SHIFT(47),
  [333] = {.entry = {.count = 1, .reusable = true}}, SHIFT(139),
  [335] = {.entry = {.count = 1, .reusable = true}}, SHIFT(54),
  [337] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_oneof_field, 7, 0, 0),
  [339] = {.entry = {.count = 1, .reusable = false}}, REDUCE(sym_oneof_field, 7, 0, 0),
  [341] = {.entry = {.count = 1, .reusable = true}}, SHIFT(118),
  [343] = {.entry = {.count = 1, .reusable = true}}, SHIFT(334),
  [345] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_edition, 4, 0, 2),
  [347] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_import, 4, 0, 3),
  [349] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_package, 3, 0, 0),
  [351] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_service, 5, 0, 0),
  [353] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_syntax, 4, 0, 0),
  [355] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_import, 3, 0, 1),
  [357] = {.entry = {.count = 1, .reusable = true}}, REDUCE(aux_sym__option_name_repeat1, 2, 0, 0),
  [359] = {.entry = {.count = 2, .reusable = true}}, REDUCE(aux_sym__option_name_repeat1, 2, 0, 0), SHIFT_REPEAT(292),
  [362] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_service, 4, 0, 0),
  [364] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_full_ident, 2, 0, 0),
  [366] = {.entry = {.count = 1, .reusable = true}}, SHIFT(292),
  [368] = {.entry = {.count = 2, .reusable = true}}, REDUCE(aux_sym_enum_body_repeat1, 2, 0, 0), SHIFT_REPEAT(124),
  [371] = {.entry = {.count = 2, .reusable = false}}, REDUCE(aux_sym_enum_body_repeat1, 2, 0, 0), SHIFT_REPEAT(215),
  [374] = {.entry = {.count = 1, .reusable = true}}, REDUCE(aux_sym_enum_body_repeat1, 2, 0, 0),
  [376] = {.entry = {.count = 2, .reusable = false}}, REDUCE(aux_sym_enum_body_repeat1, 2, 0, 0), SHIFT_REPEAT(98),
  [379] = {.entry = {.count = 2, .reusable = false}}, REDUCE(aux_sym_enum_body_repeat1, 2, 0, 0), SHIFT_REPEAT(283),
  [382] = {.entry = {.count = 1, .reusable = true}}, SHIFT(124),
  [384] = {.entry = {.count = 1, .reusable = false}}, SHIFT(215),
  [386] = {.entry = {.count = 1, .reusable = true}}, SHIFT(81),
  [388] = {.entry = {.count = 1, .reusable = false}}, SHIFT(98),
  [390] = {.entry = {.count = 1, .reusable = false}}, SHIFT(283),
  [392] = {.entry = {.count = 1, .reusable = true}}, SHIFT(72),
  [394] = {.entry = {.count = 1, .reusable = true}}, SHIFT(26),
  [396] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_full_ident, 1, 0, 0),
  [398] = {.entry = {.count = 1, .reusable = true}}, SHIFT(7),
  [400] = {.entry = {.count = 1, .reusable = true}}, REDUCE(aux_sym_string_repeat3, 2, 0, 0),
  [402] = {.entry = {.count = 2, .reusable = true}}, REDUCE(aux_sym_string_repeat3, 2, 0, 0), SHIFT_REPEAT(173),
  [405] = {.entry = {.count = 2, .reusable = true}}, REDUCE(aux_sym_string_repeat3, 2, 0, 0), SHIFT_REPEAT(152),
  [408] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_string, 1, 0, 0),
  [410] = {.entry = {.count = 1, .reusable = true}}, SHIFT(186),
  [412] = {.entry = {.count = 2, .reusable = true}}, REDUCE(aux_sym_service_repeat1, 2, 0, 0), SHIFT_REPEAT(66),
  [415] = {.entry = {.count = 2, .reusable = true}}, REDUCE(aux_sym_service_repeat1, 2, 0, 0), SHIFT_REPEAT(205),
  [418] = {.entry = {.count = 1, .reusable = true}}, REDUCE(aux_sym_service_repeat1, 2, 0, 0),
  [420] = {.entry = {.count = 2, .reusable = true}}, REDUCE(aux_sym_service_repeat1, 2, 0, 0), SHIFT_REPEAT(242),
  [423] = {.entry = {.count = 1, .reusable = true}}, REDUCE(aux_sym_string_repeat3, 3, 0, 0),
  [425] = {.entry = {.count = 1, .reusable = true}}, SHIFT(73),
  [427] = {.entry = {.count = 1, .reusable = true}}, SHIFT(242),
  [429] = {.entry = {.count = 1, .reusable = true}}, SHIFT(83),
  [431] = {.entry = {.count = 1, .reusable = true}}, SHIFT(172),
  [433] = {.entry = {.count = 1, .reusable = true}}, SHIFT(168),
  [435] = {.entry = {.count = 1, .reusable = true}}, SHIFT(169),
  [437] = {.entry = {.count = 1, .reusable = true}}, SHIFT(170),
  [439] = {.entry = {.count = 2, .reusable = true}}, REDUCE(aux_sym_rpc_repeat1, 2, 0, 0), SHIFT_REPEAT(66),
  [442] = {.entry = {.count = 2, .reusable = true}}, REDUCE(aux_sym_rpc_repeat1, 2, 0, 0), SHIFT_REPEAT(205),
  [445] = {.entry = {.count = 1, .reusable = true}}, REDUCE(aux_sym_rpc_repeat1, 2, 0, 0),
  [447] = {.entry = {.count = 1, .reusable = true}}, SHIFT(171),
  [449] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_bool, 1, 0, 0),
  [451] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_constant, 2, 0, 0),
  [453] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_constant, 1, 0, 0),
  [455] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_block_lit, 2, 0, 0),
  [457] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_block_lit, 3, 0, 0),
  [459] = {.entry = {.count = 1, .reusable = true}}, SHIFT(111),
  [461] = {.entry = {.count = 1, .reusable = true}}, SHIFT(250),
  [463] = {.entry = {.count = 1, .reusable = true}}, SHIFT(208),
  [465] = {.entry = {.count = 1, .reusable = true}}, SHIFT(185),
  [467] = {.entry = {.count = 1, .reusable = true}}, REDUCE(aux_sym_block_lit_repeat2, 6, 0, 0),
  [469] = {.entry = {.count = 1, .reusable = false}}, SHIFT(163),
  [471] = {.entry = {.count = 1, .reusable = true}}, SHIFT(193),
  [473] = {.entry = {.count = 1, .reusable = true}}, REDUCE(aux_sym_block_lit_repeat2, 7, 0, 0),
  [475] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_enum_field, 8, 0, 0),
  [477] = {.entry = {.count = 1, .reusable = false}}, REDUCE(sym_enum_field, 8, 0, 0),
  [479] = {.entry = {.count = 1, .reusable = true}}, SHIFT(198),
  [481] = {.entry = {.count = 1, .reusable = true}}, REDUCE(aux_sym_block_lit_repeat2, 4, 0, 0),
  [483] = {.entry = {.count = 1, .reusable = true}}, SHIFT(175),
  [485] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_enum_field, 4, 0, 0),
  [487] = {.entry = {.count = 1, .reusable = false}}, REDUCE(sym_enum_field, 4, 0, 0),
  [489] = {.entry = {.count = 1, .reusable = true}}, SHIFT(39),
  [491] = {.entry = {.count = 1, .reusable = false}}, SHIFT(39),
  [493] = {.entry = {.count = 1, .reusable = true}}, SHIFT(196),
  [495] = {.entry = {.count = 1, .reusable = true}}, REDUCE(aux_sym_block_lit_repeat2, 8, 0, 0),
  [497] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_enum_field, 9, 0, 0),
  [499] = {.entry = {.count = 1, .reusable = false}}, REDUCE(sym_enum_field, 9, 0, 0),
  [501] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_enum_field, 7, 0, 0),
  [503] = {.entry = {.count = 1, .reusable = false}}, REDUCE(sym_enum_field, 7, 0, 0),
  [505] = {.entry = {.count = 1, .reusable = true}}, SHIFT(211),
  [507] = {.entry = {.count = 1, .reusable = true}}, REDUCE(aux_sym_block_lit_repeat2, 5, 0, 0),
  [509] = {.entry = {.count = 1, .reusable = true}}, SHIFT(206),
  [511] = {.entry = {.count = 1, .reusable = true}}, REDUCE(aux_sym_block_lit_repeat2, 3, 0, 0),
  [513] = {.entry = {.count = 1, .reusable = true}}, SHIFT(204),
  [515] = {.entry = {.count = 1, .reusable = true}}, REDUCE(aux_sym_block_lit_repeat2, 2, 0, 0),
  [517] = {.entry = {.count = 1, .reusable = true}}, SHIFT(230),
  [519] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_enum_field, 5, 0, 0),
  [521] = {.entry = {.count = 1, .reusable = false}}, REDUCE(sym_enum_field, 5, 0, 0),
  [523] = {.entry = {.count = 1, .reusable = false}}, SHIFT(155),
  [525] = {.entry = {.count = 1, .reusable = false}}, SHIFT(165),
  [527] = {.entry = {.count = 1, .reusable = false}}, SHIFT(94),
  [529] = {.entry = {.count = 1, .reusable = true}}, SHIFT(160),
  [531] = {.entry = {.count = 1, .reusable = false}}, SHIFT_EXTRA(),
  [533] = {.entry = {.count = 1, .reusable = true}}, SHIFT(114),
  [535] = {.entry = {.count = 1, .reusable = true}}, SHIFT(226),
  [537] = {.entry = {.count = 1, .reusable = true}}, SHIFT(41),
  [539] = {.entry = {.count = 1, .reusable = true}}, SHIFT(157),
  [541] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_message_or_enum_type, 1, 0, 0),
  [543] = {.entry = {.count = 1, .reusable = true}}, SHIFT(289),
  [545] = {.entry = {.count = 1, .reusable = false}}, SHIFT(97),
  [547] = {.entry = {.count = 1, .reusable = true}}, SHIFT(177),
  [549] = {.entry = {.count = 1, .reusable = true}}, SHIFT(178),
  [551] = {.entry = {.count = 1, .reusable = true}}, SHIFT(115),
  [553] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_message_or_enum_type, 2, 0, 0),
  [555] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_rpc, 10, 0, 0),
  [557] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_rpc, 11, 0, 0),
  [559] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_rpc, 12, 0, 0),
  [561] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_rpc, 13, 0, 0),
  [563] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_rpc, 14, 0, 0),
  [565] = {.entry = {.count = 1, .reusable = true}}, SHIFT(159),
  [567] = {.entry = {.count = 2, .reusable = true}}, REDUCE(aux_sym_block_lit_repeat2, 2, 0, 0), SHIFT_REPEAT(226),
  [570] = {.entry = {.count = 2, .reusable = true}}, REDUCE(aux_sym_block_lit_repeat2, 2, 0, 0), SHIFT_REPEAT(41),
  [573] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_message_or_enum_type, 3, 0, 0),
  [575] = {.entry = {.count = 1, .reusable = false}}, REDUCE(aux_sym_string_repeat1, 2, 0, 0),
  [577] = {.entry = {.count = 2, .reusable = true}}, REDUCE(aux_sym_string_repeat1, 2, 0, 0), SHIFT_REPEAT(177),
  [580] = {.entry = {.count = 1, .reusable = false}}, REDUCE(aux_sym_string_repeat2, 2, 0, 0),
  [582] = {.entry = {.count = 2, .reusable = true}}, REDUCE(aux_sym_string_repeat2, 2, 0, 0), SHIFT_REPEAT(178),
  [585] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_ranges, 1, 0, 0),
  [587] = {.entry = {.count = 1, .reusable = true}}, SHIFT(119),
  [589] = {.entry = {.count = 1, .reusable = true}}, SHIFT(158),
  [591] = {.entry = {.count = 1, .reusable = true}}, SHIFT(304),
  [593] = {.entry = {.count = 2, .reusable = true}}, REDUCE(aux_sym_enum_field_repeat1, 2, 0, 0), SHIFT_REPEAT(158),
  [596] = {.entry = {.count = 1, .reusable = true}}, REDUCE(aux_sym_enum_field_repeat1, 2, 0, 0),
  [598] = {.entry = {.count = 1, .reusable = true}}, SHIFT(61),
  [600] = {.entry = {.count = 1, .reusable = true}}, SHIFT(162),
  [602] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_field_options, 2, 0, 0),
  [604] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_reserved_field_names, 1, 0, 0),
  [606] = {.entry = {.count = 1, .reusable = true}}, SHIFT(306),
  [608] = {.entry = {.count = 1, .reusable = true}}, SHIFT(134),
  [610] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_range, 1, 0, 0),
  [612] = {.entry = {.count = 1, .reusable = true}}, SHIFT(143),
  [614] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym__option_name, 2, 0, 0),
  [616] = {.entry = {.count = 2, .reusable = true}}, REDUCE(aux_sym_field_options_repeat1, 2, 0, 0), SHIFT_REPEAT(162),
  [619] = {.entry = {.count = 1, .reusable = true}}, REDUCE(aux_sym_field_options_repeat1, 2, 0, 0),
  [621] = {.entry = {.count = 1, .reusable = true}}, REDUCE(aux_sym_reserved_field_names_repeat1, 2, 0, 0),
  [623] = {.entry = {.count = 2, .reusable = true}}, REDUCE(aux_sym_reserved_field_names_repeat1, 2, 0, 0), SHIFT_REPEAT(306),
  [626] = {.entry = {.count = 1, .reusable = true}}, SHIFT(324),
  [628] = {.entry = {.count = 1, .reusable = true}}, SHIFT(121),
  [630] = {.entry = {.count = 1, .reusable = true}}, REDUCE(aux_sym_block_lit_repeat2, 9, 0, 0),
  [632] = {.entry = {.count = 2, .reusable = true}}, REDUCE(aux_sym_block_lit_repeat1, 2, 0, 0), SHIFT_REPEAT(61),
  [635] = {.entry = {.count = 1, .reusable = true}}, REDUCE(aux_sym_block_lit_repeat1, 2, 0, 0),
  [637] = {.entry = {.count = 1, .reusable = true}}, SHIFT(285),
  [639] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_reserved_field_names, 2, 0, 0),
  [641] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym__option_name, 1, 0, 0),
  [643] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_ranges, 2, 0, 0),
  [645] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_field_options, 1, 0, 0),
  [647] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym__option_name, 4, 0, 0),
  [649] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym__option_name, 3, 0, 0),
  [651] = {.entry = {.count = 1, .reusable = true}}, REDUCE(aux_sym_ranges_repeat1, 2, 0, 0),
  [653] = {.entry = {.count = 2, .reusable = true}}, REDUCE(aux_sym_ranges_repeat1, 2, 0, 0), SHIFT_REPEAT(119),
  [656] = {.entry = {.count = 1, .reusable = true}}, SHIFT(19),
  [658] = {.entry = {.count = 1, .reusable = true}}, SHIFT(147),
  [660] = {.entry = {.count = 1, .reusable = true}}, SHIFT(13),
  [662] = {.entry = {.count = 1, .reusable = true}}, SHIFT(137),
  [664] = {.entry = {.count = 1, .reusable = true}}, SHIFT(294),
  [666] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_enum_value_option, 3, 0, 0),
  [668] = {.entry = {.count = 1, .reusable = true}}, SHIFT(309),
  [670] = {.entry = {.count = 1, .reusable = true}}, SHIFT(164),
  [672] = {.entry = {.count = 1, .reusable = true}}, SHIFT(89),
  [674] = {.entry = {.count = 1, .reusable = true}}, SHIFT(252),
  [676] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_range, 3, 0, 0),
  [678] = {.entry = {.count = 1, .reusable = true}}, SHIFT(146),
  [680] = {.entry = {.count = 1, .reusable = true}}, SHIFT(156),
  [682] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_field_option, 3, 0, 0),
  [684] = {.entry = {.count = 1, .reusable = true}}, SHIFT(6),
  [686] = {.entry = {.count = 1, .reusable = true}}, SHIFT(15),
  [688] = {.entry = {.count = 1, .reusable = true}}, SHIFT(122),
  [690] = {.entry = {.count = 1, .reusable = true}}, SHIFT(176),
  [692] = {.entry = {.count = 1, .reusable = true}}, SHIFT(167),
  [694] = {.entry = {.count = 1, .reusable = true}}, SHIFT(102),
  [696] = {.entry = {.count = 1, .reusable = true}}, SHIFT(103),
  [698] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_type, 1, 0, 0),
  [700] = {.entry = {.count = 1, .reusable = true}}, SHIFT(296),
  [702] = {.entry = {.count = 1, .reusable = true}}, SHIFT(86),
  [704] = {.entry = {.count = 1, .reusable = true}}, SHIFT(2),
  [706] = {.entry = {.count = 1, .reusable = true}}, SHIFT(313),
  [708] = {.entry = {.count = 2, .reusable = true}}, REDUCE(aux_sym_message_or_enum_type_repeat1, 2, 0, 0), SHIFT_REPEAT(282),
  [711] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_message_name, 1, 0, 0),
  [713] = {.entry = {.count = 1, .reusable = true}}, SHIFT(227),
  [715] = {.entry = {.count = 1, .reusable = true}}, SHIFT(248),
  [717] = {.entry = {.count = 1, .reusable = true}}, SHIFT(131),
  [719] = {.entry = {.count = 1, .reusable = true}}, SHIFT(154),
  [721] = {.entry = {.count = 1, .reusable = true}}, SHIFT(88),
  [723] = {.entry = {.count = 1, .reusable = true}}, SHIFT(16),
  [725] = {.entry = {.count = 1, .reusable = true}}, SHIFT(117),
  [727] = {.entry = {.count = 1, .reusable = true}}, SHIFT(266),
  [729] = {.entry = {.count = 1, .reusable = true}}, SHIFT(267),
  [731] = {.entry = {.count = 1, .reusable = true}}, SHIFT(105),
  [733] = {.entry = {.count = 1, .reusable = true}}, SHIFT(287),
  [735] = {.entry = {.count = 1, .reusable = true}}, SHIFT(315),
  [737] = {.entry = {.count = 1, .reusable = true}}, SHIFT(126),
  [739] = {.entry = {.count = 1, .reusable = true}}, SHIFT(323),
  [741] = {.entry = {.count = 1, .reusable = true}}, SHIFT(140),
  [743] = {.entry = {.count = 1, .reusable = true}}, SHIFT(272),
  [745] = {.entry = {.count = 1, .reusable = true}}, SHIFT(214),
  [747] = {.entry = {.count = 1, .reusable = true}}, SHIFT(17),
  [749] = {.entry = {.count = 1, .reusable = true}}, SHIFT(32),
  [751] = {.entry = {.count = 1, .reusable = true}}, SHIFT(130),
  [753] = {.entry = {.count = 1, .reusable = true}}, SHIFT(68),
  [755] = {.entry = {.count = 1, .reusable = true}}, SHIFT(123),
  [757] = {.entry = {.count = 1, .reusable = true}}, SHIFT(9),
  [759] = {.entry = {.count = 1, .reusable = true}}, SHIFT(20),
  [761] = {.entry = {.count = 1, .reusable = true}}, SHIFT(312),
  [763] = {.entry = {.count = 1, .reusable = true}}, REDUCE(aux_sym_message_or_enum_type_repeat1, 2, 0, 0),
  [765] = {.entry = {.count = 1, .reusable = true}}, SHIFT(149),
  [767] = {.entry = {.count = 1, .reusable = true}}, SHIFT(151),
  [769] = {.entry = {.count = 1, .reusable = true}}, SHIFT(90),
  [771] = {.entry = {.count = 1, .reusable = true}}, SHIFT(314),
  [773] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_enum_name, 1, 0, 0),
  [775] = {.entry = {.count = 1, .reusable = true}}, SHIFT(67),
  [777] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_rpc_name, 1, 0, 0),
  [779] = {.entry = {.count = 1, .reusable = true}}, SHIFT(150),
  [781] = {.entry = {.count = 1, .reusable = true}}, SHIFT(280),
  [783] = {.entry = {.count = 1, .reusable = true}}, SHIFT(290),
  [785] = {.entry = {.count = 1, .reusable = true}}, SHIFT(40),
  [787] = {.entry = {.count = 1, .reusable = true}}, SHIFT(129),
  [789] = {.entry = {.count = 1, .reusable = true}}, SHIFT(77),
  [791] = {.entry = {.count = 1, .reusable = true}}, SHIFT(148),
  [793] = {.entry = {.count = 1, .reusable = true}}, SHIFT(136),
  [795] = {.entry = {.count = 1, .reusable = true}}, SHIFT(330),
  [797] = {.entry = {.count = 1, .reusable = true}}, SHIFT(220),
  [799] = {.entry = {.count = 1, .reusable = true}}, SHIFT(31),
  [801] = {.entry = {.count = 1, .reusable = true}}, SHIFT(64),
  [803] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_service_name, 1, 0, 0),
  [805] = {.entry = {.count = 1, .reusable = true}}, SHIFT(60),
  [807] = {.entry = {.count = 1, .reusable = true}}, SHIFT(100),
  [809] = {.entry = {.count = 1, .reusable = true}}, SHIFT(291),
  [811] = {.entry = {.count = 1, .reusable = true}}, SHIFT(76),
  [813] = {.entry = {.count = 1, .reusable = true}}, SHIFT(120),
  [815] = {.entry = {.count = 1, .reusable = true}}, SHIFT(275),
  [817] = {.entry = {.count = 1, .reusable = true}}, SHIFT(245),
  [819] = {.entry = {.count = 1, .reusable = true}}, SHIFT(59),
  [821] = {.entry = {.count = 1, .reusable = true}}, SHIFT(238),
  [823] = {.entry = {.count = 1, .reusable = true}},  ACCEPT_INPUT(),
  [825] = {.entry = {.count = 1, .reusable = true}}, SHIFT(301),
  [827] = {.entry = {.count = 1, .reusable = true}}, SHIFT(135),
  [829] = {.entry = {.count = 1, .reusable = true}}, SHIFT(133),
  [831] = {.entry = {.count = 1, .reusable = true}}, SHIFT(145),
  [833] = {.entry = {.count = 1, .reusable = true}}, SHIFT(138),
  [835] = {.entry = {.count = 1, .reusable = true}}, SHIFT(29),
  [837] = {.entry = {.count = 1, .reusable = true}}, SHIFT(8),
  [839] = {.entry = {.count = 1, .reusable = true}}, SHIFT(56),
  [841] = {.entry = {.count = 1, .reusable = true}}, SHIFT(166),
  [843] = {.entry = {.count = 1, .reusable = true}}, SHIFT(132),
  [845] = {.entry = {.count = 1, .reusable = true}}, SHIFT(18),
  [847] = {.entry = {.count = 1, .reusable = true}}, SHIFT(307),
  [849] = {.entry = {.count = 1, .reusable = true}}, SHIFT(52),
  [851] = {.entry = {.count = 1, .reusable = true}}, SHIFT(71),
  [853] = {.entry = {.count = 1, .reusable = true}}, REDUCE(sym_key_type, 1, 0, 0),
  [855] = {.entry = {.count = 1, .reusable = true}}, SHIFT(49),
  [857] = {.entry = {.count = 1, .reusable = true}}, SHIFT(281),
  [859] = {.entry = {.count = 1, .reusable = true}}, SHIFT(240),
  [861] = {.entry = {.count = 1, .reusable = true}}, SHIFT(62),
  [863] = {.entry = {.count = 1, .reusable = true}}, SHIFT(63),
  [865] = {.entry = {.count = 1, .reusable = true}}, SHIFT(57),
  [867] = {.entry = {.count = 1, .reusable = true}}, SHIFT(293),
  [869] = {.entry = {.count = 1, .reusable = true}}, SHIFT(329),
  [871] = {.entry = {.count = 1, .reusable = true}}, SHIFT(65),
  [873] = {.entry = {.count = 1, .reusable = true}}, SHIFT(58),
};

#ifdef __cplusplus
extern "C" {
#endif
#ifdef TREE_SITTER_HIDE_SYMBOLS
#define TS_PUBLIC
#elif defined(_WIN32)
#define TS_PUBLIC __declspec(dllexport)
#else
#define TS_PUBLIC __attribute__((visibility("default")))
#endif

TS_PUBLIC const TSLanguage *tree_sitter_proto(void) {
  static const TSLanguage language = {
    .version = LANGUAGE_VERSION,
    .symbol_count = SYMBOL_COUNT,
    .alias_count = ALIAS_COUNT,
    .token_count = TOKEN_COUNT,
    .external_token_count = EXTERNAL_TOKEN_COUNT,
    .state_count = STATE_COUNT,
    .large_state_count = LARGE_STATE_COUNT,
    .production_id_count = PRODUCTION_ID_COUNT,
    .field_count = FIELD_COUNT,
    .max_alias_sequence_length = MAX_ALIAS_SEQUENCE_LENGTH,
    .parse_table = &ts_parse_table[0][0],
    .small_parse_table = ts_small_parse_table,
    .small_parse_table_map = ts_small_parse_table_map,
    .parse_actions = ts_parse_actions,
    .symbol_names = ts_symbol_names,
    .field_names = ts_field_names,
    .field_map_slices = ts_field_map_slices,
    .field_map_entries = ts_field_map_entries,
    .symbol_metadata = ts_symbol_metadata,
    .public_symbol_map = ts_symbol_map,
    .alias_map = ts_non_terminal_alias_map,
    .alias_sequences = &ts_alias_sequences[0][0],
    .lex_modes = ts_lex_modes,
    .lex_fn = ts_lex,
    .primary_state_ids = ts_primary_state_ids,
  };
  return &language;
}
#ifdef __cplusplus
}
#endif
