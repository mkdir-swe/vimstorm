//! Minimal JSON reader for `rg --json` lines (no serde_json dependency for one line format).

#[derive(Debug, Clone, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Json>),
    /// Insertion order kept; rg objects are small, so lookups scan linearly.
    Obj(Vec<(String, Json)>),
}

impl Json {
    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Obj(fields) => fields.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Json::Str(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Json::Num(n) => Some(*n),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&[Json]> {
        match self {
            Json::Arr(items) => Some(items),
            _ => None,
        }
    }
}

/// Parses one complete JSON document; trailing non-whitespace is an error.
pub fn parse(src: &str) -> Result<Json, String> {
    let mut p = Parser {
        s: src.as_bytes(),
        i: 0,
        depth: 0,
    };
    let v = p.value()?;
    p.ws();
    if p.i != p.s.len() {
        return Err(p.err("trailing characters"));
    }
    Ok(v)
}

struct Parser<'a> {
    s: &'a [u8],
    i: usize,
    depth: u32,
}

/// Guards the recursive descent against stack overflow on hostile input.
const MAX_DEPTH: u32 = 128;

impl Parser<'_> {
    fn err(&self, what: &str) -> String {
        format!("json: {what} at byte {}", self.i)
    }

    fn ws(&mut self) {
        while let Some(b' ' | b'\t' | b'\n' | b'\r') = self.s.get(self.i) {
            self.i += 1;
        }
    }

    fn eat(&mut self, lit: &str) -> Result<(), String> {
        if self.s[self.i..].starts_with(lit.as_bytes()) {
            self.i += lit.len();
            Ok(())
        } else {
            Err(self.err("unexpected token"))
        }
    }

    fn value(&mut self) -> Result<Json, String> {
        self.ws();
        match self.s.get(self.i) {
            Some(b'{') => self.nested(Self::object),
            Some(b'[') => self.nested(Self::array),
            Some(b'"') => self.string().map(Json::Str),
            Some(b't') => self.eat("true").map(|_| Json::Bool(true)),
            Some(b'f') => self.eat("false").map(|_| Json::Bool(false)),
            Some(b'n') => self.eat("null").map(|_| Json::Null),
            Some(b'-' | b'0'..=b'9') => self.number(),
            Some(_) => Err(self.err("unexpected character")),
            None => Err(self.err("unexpected end")),
        }
    }

    fn nested(&mut self, f: fn(&mut Self) -> Result<Json, String>) -> Result<Json, String> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return Err(self.err("nesting too deep"));
        }
        let v = f(self);
        self.depth -= 1;
        v
    }

    fn object(&mut self) -> Result<Json, String> {
        self.i += 1; // '{'
        let mut fields = Vec::new();
        self.ws();
        if self.s.get(self.i) == Some(&b'}') {
            self.i += 1;
            return Ok(Json::Obj(fields));
        }
        loop {
            self.ws();
            if self.s.get(self.i) != Some(&b'"') {
                return Err(self.err("expected key"));
            }
            let key = self.string()?;
            self.ws();
            self.eat(":")?;
            fields.push((key, self.value()?));
            self.ws();
            match self.s.get(self.i) {
                Some(b',') => self.i += 1,
                Some(b'}') => {
                    self.i += 1;
                    return Ok(Json::Obj(fields));
                }
                _ => return Err(self.err("expected ',' or '}'")),
            }
        }
    }

    fn array(&mut self) -> Result<Json, String> {
        self.i += 1; // '['
        let mut items = Vec::new();
        self.ws();
        if self.s.get(self.i) == Some(&b']') {
            self.i += 1;
            return Ok(Json::Arr(items));
        }
        loop {
            items.push(self.value()?);
            self.ws();
            match self.s.get(self.i) {
                Some(b',') => self.i += 1,
                Some(b']') => {
                    self.i += 1;
                    return Ok(Json::Arr(items));
                }
                _ => return Err(self.err("expected ',' or ']'")),
            }
        }
    }

    fn number(&mut self) -> Result<Json, String> {
        let start = self.i;
        while let Some(b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9') = self.s.get(self.i) {
            self.i += 1;
        }
        // the scanned bytes are ASCII, so this slice is valid UTF-8
        let text = std::str::from_utf8(&self.s[start..self.i]).unwrap_or_default();
        text.parse::<f64>()
            .map(Json::Num)
            .map_err(|_| self.err("bad number"))
    }

    fn hex4(&mut self) -> Result<u32, String> {
        let digits = self
            .s
            .get(self.i..self.i + 4)
            .ok_or_else(|| self.err("short \\u escape"))?;
        let text = std::str::from_utf8(digits).map_err(|_| self.err("bad \\u escape"))?;
        let n = u32::from_str_radix(text, 16).map_err(|_| self.err("bad \\u escape"))?;
        self.i += 4;
        Ok(n)
    }

    fn string(&mut self) -> Result<String, String> {
        self.i += 1; // opening quote
        let mut out = String::new();
        loop {
            // copy the run of plain bytes in one go (input is &str, so runs end on char boundaries
            // at '"' / '\\', which are ASCII)
            let run = self.i;
            while let Some(&b) = self.s.get(self.i) {
                if b == b'"' || b == b'\\' {
                    break;
                }
                self.i += 1;
            }
            out.push_str(std::str::from_utf8(&self.s[run..self.i]).map_err(|_| self.err("utf-8"))?);
            match self.s.get(self.i) {
                Some(b'"') => {
                    self.i += 1;
                    return Ok(out);
                }
                Some(b'\\') => {
                    self.i += 1;
                    let Some(&esc) = self.s.get(self.i) else {
                        return Err(self.err("unexpected end"));
                    };
                    self.i += 1;
                    match esc {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => out.push(self.unicode_escape()?),
                        _ => return Err(self.err("bad escape")),
                    }
                }
                _ => return Err(self.err("unterminated string")),
            }
        }
    }

    /// After `\u`: one code unit, or a surrogate pair. Lone surrogates become U+FFFD, like a lossy
    /// UTF-16 decode.
    fn unicode_escape(&mut self) -> Result<char, String> {
        let hi = self.hex4()?;
        if (0xD800..0xDC00).contains(&hi) && self.s[self.i..].starts_with(b"\\u") {
            let save = self.i;
            self.i += 2;
            let lo = self.hex4()?;
            if (0xDC00..0xE000).contains(&lo) {
                let c = 0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00);
                return Ok(char::from_u32(c).unwrap_or('\u{FFFD}'));
            }
            // not a low surrogate: leave it for the next escape
            self.i = save;
        }
        Ok(char::from_u32(hi).unwrap_or('\u{FFFD}'))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn values_parse_and_bad_json_is_an_error() {
        assert_eq!(parse("null"), Ok(Json::Null));
        assert_eq!(parse(" true "), Ok(Json::Bool(true)));
        assert_eq!(parse("false"), Ok(Json::Bool(false)));
        assert_eq!(parse("-12.5e1"), Ok(Json::Num(-125.0)));
        assert_eq!(parse("0"), Ok(Json::Num(0.0)));
        let v = parse(r#"{"a": [1, {"b": null}, "x"], "c": {}, "d": []}"#).unwrap();
        let a = v.get("a").and_then(Json::as_array).unwrap();
        assert_eq!(a[0].as_f64(), Some(1.0));
        assert_eq!(a[1].get("b"), Some(&Json::Null));
        assert_eq!(a[2].as_str(), Some("x"));
        assert_eq!(v.get("c"), Some(&Json::Obj(vec![])));
        assert_eq!(v.get("d"), Some(&Json::Arr(vec![])));
        assert!(v.get("zz").is_none());
        let deep = "[".repeat(1000);
        for bad in ["tru", "1 2", "", "[1,]", r#"{"a" 1}"#, &deep] {
            assert!(parse(bad).is_err(), "{bad:.20}");
        }
    }

    /// (name, JSON string, decoded text; None: an error)
    const STRINGS: &[(&str, &str, Option<&str>)] = &[
        (
            "escapes",
            r#""a\"b\\c\/d\b\f\n\r\té€""#,
            Some("a\"b\\c/d\u{8}\u{c}\n\r\t\u{e9}\u{20ac}"),
        ),
        (
            "a surrogate pair is one astral char",
            r#""😀""#,
            Some("\u{1F600}"),
        ),
        ("a lone high surrogate", r#""\ud83dx""#, Some("\u{FFFD}x")),
        ("a lone low surrogate", r#""\ude00""#, Some("\u{FFFD}")),
        (
            "a high surrogate before an escape",
            r#""\ud83dA""#,
            Some("\u{FFFD}A"),
        ),
        ("raw UTF-8 passes through", "\"åäö\"", Some("åäö")),
        ("unclosed", r#""abc"#, None),
        ("an unknown escape", r#""\x""#, None),
        ("a short \\u", r#""\u12""#, None),
    ];

    #[test]
    fn strings_decode_escapes() {
        for (name, json, want) in STRINGS {
            let got = parse(json).ok();
            assert_eq!(got.as_ref().map(|v| v.as_str()), want.map(Some), "{name}");
        }
    }
}
