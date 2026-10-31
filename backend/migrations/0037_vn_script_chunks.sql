-- Successful model responses survive retries and backend restarts, within one authorized snapshot job.
CREATE TABLE vn_script_chunks (
    job_id UUID NOT NULL REFERENCES vn_script_jobs(id) ON DELETE CASCADE,
    part_index INTEGER NOT NULL CHECK (part_index >= 0),
    request_hash TEXT NOT NULL,
    response JSONB NOT NULL,
    PRIMARY KEY (job_id, part_index)
);
