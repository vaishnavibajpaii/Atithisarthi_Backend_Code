-- OPTIONAL, only after catalog confirms cron.job exists and operator can SELECT.
-- Deliberately excludes SQL commands, usernames and connection targets.
-- A command fingerprint is NOT proof the job is safe or currently succeeding.
begin transaction read only;
set local statement_timeout = '10s';
select jobid, schedule, active, md5(command) as command_md5
from cron.job order by jobid;
commit;
