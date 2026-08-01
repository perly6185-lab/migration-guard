local key = KEYS[1]
local sequence = tonumber(ARGV[1])
local state = ARGV[2]
local event_hash = ARGV[3]
local total = tonumber(ARGV[4])
local committed = tonumber(ARGV[5])
local failed = tonumber(ARGV[6])

local current_sequence = tonumber(redis.call('HGET', key, 'sequence') or '0')
local current_hash = redis.call('HGET', key, 'event_hash')
local current_state = redis.call('HGET', key, 'state')
local terminal = redis.call('HGET', key, 'terminal') == '1'

if sequence == current_sequence and current_sequence > 0 then
  if current_hash == event_hash and current_state == state then
    return 'REPLAYED'
  end
  return 'SEQUENCE_CONFLICT'
end
if terminal then
  return 'TERMINAL'
end
if sequence ~= current_sequence + 1 then
  return 'OUT_OF_ORDER'
end
if current_sequence == 0 and state ~= 'RUNNING' then
  return 'INVALID_TRANSITION'
end
if current_state == 'RUNNING'
  and state ~= 'SUCCESS'
  and state ~= 'PARTIAL_FAILED'
  and state ~= 'FAILED' then
  return 'INVALID_TRANSITION'
end
if state ~= 'RUNNING' and total ~= committed + failed then
  return 'COUNTER_MISMATCH'
end

local is_terminal =
  state == 'SUCCESS'
  or state == 'PARTIAL_FAILED'
  or state == 'FAILED'
redis.call('HSET', key,
  'sequence', sequence,
  'state', state,
  'event_hash', event_hash,
  'total', total,
  'committed', committed,
  'failed', failed,
  'terminal', is_terminal and '1' or '0')
redis.call('EXPIRE', key, 86400)
return 'STORED'
