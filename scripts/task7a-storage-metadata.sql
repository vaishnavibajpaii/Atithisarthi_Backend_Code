-- OPTIONAL, only after catalog confirms storage.buckets exists.
-- Bucket settings only: no objects, owner IDs, paths or customer files.
begin transaction read only;
set local statement_timeout = '10s';
select id as bucket_id, public, file_size_limit, allowed_mime_types
from storage.buckets order by id;
commit;
