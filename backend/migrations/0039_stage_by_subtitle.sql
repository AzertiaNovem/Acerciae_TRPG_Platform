-- A visual novel's stage names a character and a subtitle (SAY, ANGRY, …), never a particular image: the image shown
-- is the character's current one for that subtitle, looked up when the presentation is read. Existing placements
-- keep the subtitle of the image they pointed at when they had none, and drop the image reference.
UPDATE presentation_events pe SET character_asset_ids = (
    SELECT COALESCE(jsonb_agg(
        (pl - 'asset_id' - 'asset_version') || jsonb_build_object('expression',
            CASE WHEN btrim(COALESCE(pl->>'expression', '')) NOT IN ('', 'default') THEN pl->>'expression'
                 WHEN m.asset_type = 'standee' AND btrim(m.expression) NOT IN ('', 'default', 'portrait', 'avatar') THEN m.expression
                 ELSE 'default' END)
        ORDER BY t.ord), '[]'::jsonb)
    FROM jsonb_array_elements(pe.character_asset_ids) WITH ORDINALITY AS t(pl, ord)
    LEFT JOIN media_assets m ON m.id::text = t.pl->>'asset_id'
    WHERE jsonb_typeof(t.pl) = 'object')
WHERE jsonb_typeof(pe.character_asset_ids) = 'array' AND pe.character_asset_ids::text LIKE '%asset_id%';
