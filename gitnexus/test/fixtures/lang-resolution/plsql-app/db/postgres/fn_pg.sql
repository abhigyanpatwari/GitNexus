CREATE OR REPLACE FUNCTION mark_items_dirty(p_id integer) RETURNS void AS $$
BEGIN
  UPDATE items SET dirty = true WHERE id = p_id;
END;
$$ LANGUAGE plpgsql;
