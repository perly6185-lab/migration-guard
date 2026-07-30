local key = KEYS[1]
local owner = ARGV[1]

local existing_owner = redis.call('HGET', key, 'owner')
if not existing_owner then
  return 'OWNER_MISSING'
end
if existing_owner ~= owner then
  return 'OWNER_CONFLICT'
end
redis.call('DEL', key)
return 'RELEASED'
