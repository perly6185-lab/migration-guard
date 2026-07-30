use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestContext {
    pub tenant_id: u64,
    pub user_id: u64,
    pub device_id: String,
    pub request_id: String,
    pub trace_id: String,
    pub datasource: String,
    pub snapshot_id: String,
}

impl RequestContext {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.tenant_id == 0 {
            return Err("tenant is required");
        }
        if self.user_id == 0 {
            return Err("user is required");
        }
        if self.device_id.trim().is_empty() {
            return Err("device is required");
        }
        if self.request_id.trim().is_empty() || self.trace_id.trim().is_empty() {
            return Err("request and trace are required");
        }
        if self.datasource.trim().is_empty() || self.snapshot_id.trim().is_empty() {
            return Err("datasource and snapshot are required");
        }
        Ok(())
    }
}
