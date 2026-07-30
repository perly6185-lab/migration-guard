local key = KEYS[1]
local mode = ARGV[1]
local owner = ARGV[2]
local now = tonumber(ARGV[3])
local expires_at = tonumber(ARGV[4])

local entries = redis.call("HGETALL", key)
for index = 1, #entries, 2 do
  local field = entries[index]
  local expiry = tonumber(entries[index + 1])
  if expiry == nil or expiry <= now then
    redis.call("HDEL", key, field)
  end
end

local owner_field = mode .. ":" .. owner
if redis.call("HEXISTS", key, owner_field) == 1 then
  redis.call("HSET", key, owner_field, expires_at)
  redis.call("PEXPIREAT", key, expires_at)
  return "ACQUIRED"
end

local active = redis.call("HKEYS", key)
if mode == "refresh" then
  if #active > 0 then
    return "BUSY"
  end
elseif mode == "batch" then
  for _, field in ipairs(active) do
    if string.sub(field, 1, 8) == "refresh:" then
      return "BUSY"
    end
  end
else
  return "OWNER_CONFLICT"
end

redis.call("HSET", key, owner_field, expires_at)
redis.call("PEXPIREAT", key, expires_at)
return "ACQUIRED"
