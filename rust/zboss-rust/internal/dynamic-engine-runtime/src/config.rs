use std::net::{IpAddr, Ipv4Addr, SocketAddr};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Profile {
    Memory,
    Production,
}

impl Profile {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Memory => "memory",
            Self::Production => "production",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    pub bind: SocketAddr,
    pub profile: Profile,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let bind = std::env::var("ZBOSS_PAGE_BIND")
            .unwrap_or_else(|_| "127.0.0.1:18081".to_owned())
            .parse()
            .map_err(|error| format!("invalid ZBOSS_PAGE_BIND: {error}"))?;
        let profile = match std::env::var("ZBOSS_PAGE_PROFILE")
            .unwrap_or_else(|_| "memory".to_owned())
            .as_str()
        {
            "memory" => Profile::Memory,
            "production" => Profile::Production,
            value => return Err(format!("unsupported ZBOSS_PAGE_PROFILE: {value}")),
        };
        Ok(Self { bind, profile })
    }
}

impl Default for Config {
    fn default() -> Self {
        Self {
            bind: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 18081),
            profile: Profile::Memory,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_loopback_memory_profile() {
        let config = Config::default();
        assert!(config.bind.ip().is_loopback());
        assert_eq!(config.profile, Profile::Memory);
    }
}
