use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Envelope<T> {
    pub code: i32,
    pub msg: String,
    pub data: Option<T>,
}

impl<T> Envelope<T> {
    pub fn success(data: T) -> Self {
        Self {
            code: 0,
            msg: "success".to_owned(),
            data: Some(data),
        }
    }

    pub fn failure(code: i32, message: impl Into<String>) -> Self {
        Self {
            code,
            msg: message.into(),
            data: None,
        }
    }
}
