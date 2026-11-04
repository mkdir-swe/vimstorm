; extends
; WebStorm Darcula (colors/darcula-contrast.lua): only "," and ";" are orange, "." and ":" are plain text.
[
  "."
  ":"
  "?."
] @punctuation.delimiter.plain

; Lib globals are JS.GLOBAL_VARIABLE (purple bold italic), not keywords
((identifier) @variable.global
  (#any-of? @variable.global
    "console" "window" "document" "globalThis" "process" "JSON" "Math" "Reflect" "Intl"
    "localStorage" "sessionStorage" "navigator" "location"))

; export const x = ... is JS.EXPORTED_VARIABLE; exported arrow/function values stay function declarations
(export_statement
  declaration: (lexical_declaration
    (variable_declarator
      name: (identifier) @variable.exported
      value: (_) @_value
      (#not-kind-eq? @_value "arrow_function" "function_expression"))))

; The whole regex literal is JS.REGEXP, including delimiters and flags
(regex
  "/" @string.regexp)

(regex_flags) @string.regexp

; Type operators and optional markers are operation signs
(union_type
  "|" @punctuation.delimiter.plain)

(intersection_type
  "&" @punctuation.delimiter.plain)

[
  "?:"
  "-?:"
  "+?:"
] @punctuation.delimiter.plain

; Captures that match what vtsls semantic tokens say later (colors/darcula-contrast.lua), so nothing changes
; color a few seconds after opening a file.
; `{ name }` shorthand is the variable it names (LspTokenUpdate in config/autocmds.lua)
(shorthand_property_identifier) @variable

; A parameter is plain, also when named like a lib global above (`(location) =>`)
[
  (required_parameter
    pattern: (identifier) @variable.plain)
  (optional_parameter
    pattern: (identifier) @variable.plain)
  (arrow_function
    parameter: (identifier) @variable.plain)
]

; `self` is a plain name (a callback parameter, mostly), not a keyword
((identifier) @variable
  (#eq? @variable "self"))

; Builtin constructors (Object, Promise, Error...) are classes (default text), not keywords
((identifier) @type
  (#any-of? @type
    "Object" "Function" "Boolean" "Symbol" "Number" "Date" "String" "RegExp" "Map" "Set" "WeakMap"
    "WeakSet" "Promise" "Array" "Int8Array" "Uint8Array" "Uint8ClampedArray" "Int16Array" "Uint16Array"
    "Int32Array" "Uint32Array" "Float32Array" "Float64Array" "ArrayBuffer" "DataView" "Error" "EvalError"
    "InternalError" "RangeError" "ReferenceError" "SyntaxError" "TypeError" "URIError")
  (#not-has-parent? @type jsx_opening_element jsx_closing_element jsx_self_closing_element))

; Lib functions are JS.GLOBAL_FUNCTION
((identifier) @function.builtin
  (#any-of? @function.builtin
    "setTimeout" "clearTimeout" "setInterval" "clearInterval" "setImmediate" "clearImmediate" "fetch"
    "queueMicrotask" "structuredClone" "requestAnimationFrame" "cancelAnimationFrame" "atob" "btoa" "alert"
    "confirm" "prompt"))

; Static members and enum members are DEFAULT_STATIC_FIELD / _METHOD; `Enum.MEMBER` by its case
(public_field_definition
  "static"
  name: (property_identifier) @variable.member.static)

(method_definition
  "static"
  name: (property_identifier) @function.method.static)

(enum_body
  name: (property_identifier) @variable.member.static)

(enum_assignment
  name: (property_identifier) @variable.member.static)

((member_expression
  object: (identifier) @_enum
  property: (property_identifier) @variable.member.static)
  (#lua-match? @_enum "^[A-Z]")
  (#lua-match? @variable.member.static "^[A-Z][A-Z%d_]+$"))

; Type parameters (TS.TYPE_PARAMETER): declarations, and one-letter names (T, K, V) where they're used
(type_parameter
  name: (type_identifier) @type.parameter)

((type_identifier) @type.parameter
  (#lua-match? @type.parameter "^[A-Z]$"))
