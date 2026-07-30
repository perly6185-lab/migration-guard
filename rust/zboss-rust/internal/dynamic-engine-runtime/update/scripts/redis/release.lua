local key = KEYS[1]
local mode = ARGV[1]
local owner = ARGV[2]
local owner_field = mode .. ":" .. owner

if redis.call("HDEL", key, owner_field) == 0 then
  return "OWNER_MISSING"
end

if redis.call("HLEN", key) == 0 then
  redis.call("DEL", key)
end
return "RELEASED"
