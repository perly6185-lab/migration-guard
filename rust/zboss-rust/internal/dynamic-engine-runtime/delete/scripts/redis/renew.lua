local key = KEYS[1]
local owner = ARGV[1]
local now = tonumber(ARGV[2])
local expires = tonumber(ARGV[3])

local existing_owner = redis.call('HGET', key, 'owner')
local existing_expiry = tonumber(redis.call('HGET', key, 'expires') or '0')
if not existing_owner or existing_expiry <= now then
  redis.call('DEL', key)
  return 'OWNER_MISSING'
end
if existing_owner ~= owner then
  return 'OWNER_CONFLICT'
end
redis.call('HSET', key, 'expires', expires)
redis.call('PEXPIREAT', key, expires)
return 'RENEWED'
