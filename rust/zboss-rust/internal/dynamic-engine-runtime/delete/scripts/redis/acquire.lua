local key = KEYS[1]
local owner = ARGV[1]
local operation = ARGV[2]
local now = tonumber(ARGV[3])
local expires = tonumber(ARGV[4])

local existing_owner = redis.call('HGET', key, 'owner')
local existing_expiry = tonumber(redis.call('HGET', key, 'expires') or '0')
if existing_owner and existing_expiry > now then
  if existing_owner == owner then
    local existing_operation = redis.call('HGET', key, 'operation')
    if existing_operation ~= operation then
      return 'OWNER_CONFLICT'
    end
    redis.call('HSET', key, 'expires', expires)
    redis.call('PEXPIREAT', key, expires)
    return 'ACQUIRED'
  end
  return 'BUSY'
end

redis.call('DEL', key)
redis.call('HSET', key,
  'owner', owner,
  'operation', operation,
  'expires', expires)
redis.call('PEXPIREAT', key, expires)
return 'ACQUIRED'
