ALTER TABLE opportunities
ADD COLUMN rfp_extraction_method TEXT NOT NULL DEFAULT 'native';

ALTER TABLE proposals
ADD COLUMN extraction_method TEXT NOT NULL DEFAULT 'native';
