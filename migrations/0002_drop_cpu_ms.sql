-- cpu_ms held elapsed time, not CPU time (workerd only advances timers on I/O). CPU time is in
-- Workers Logs instead.
ALTER TABLE mail DROP COLUMN cpu_ms;
