-- Idempotent database guards. Run AFTER migrations: npm run db:guards
-- Safe to re-run (CREATE OR REPLACE / DROP TRIGGER IF EXISTS).

-- 1. Append-only tables ------------------------------------------------------
CREATE OR REPLACE FUNCTION forbid_update_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed (append-only table)', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'activity_events', 'ledger_entries', 'ledger_lines',
    'evidence', 'project_baselines', 'message_translations'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_append_only ON %1$I', t);
    EXECUTE format(
      'CREATE TRIGGER trg_%1$s_append_only BEFORE UPDATE OR DELETE ON %1$I
         FOR EACH ROW EXECUTE FUNCTION forbid_update_delete()', t);
  END LOOP;
END $$;

-- 2. Original chat text can never be overwritten (PRD §28) --------------------
CREATE OR REPLACE FUNCTION messages_protect_original() RETURNS trigger AS $$
BEGIN
  IF NEW.original_text IS DISTINCT FROM OLD.original_text
     OR NEW.original_language IS DISTINCT FROM OLD.original_language
     OR NEW.sender_user_id IS DISTINCT FROM OLD.sender_user_id THEN
    RAISE EXCEPTION 'messages.original_text / original_language / sender are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_messages_protect_original ON messages;
CREATE TRIGGER trg_messages_protect_original BEFORE UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION messages_protect_original();

-- 3. Quote versions are immutable once submitted (PRD §53) --------------------
CREATE OR REPLACE FUNCTION quote_versions_freeze() RETURNS trigger AS $$
BEGIN
  IF OLD.submitted_at IS NOT NULL THEN
    RAISE EXCEPTION 'quote version % is submitted and immutable', OLD.id;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_quote_versions_freeze ON quote_versions;
CREATE TRIGGER trg_quote_versions_freeze BEFORE UPDATE OR DELETE ON quote_versions
  FOR EACH ROW EXECUTE FUNCTION quote_versions_freeze();

CREATE OR REPLACE FUNCTION quote_line_items_freeze() RETURNS trigger AS $$
DECLARE v_id uuid; submitted timestamptz;
BEGIN
  IF TG_OP = 'INSERT' THEN v_id := NEW.quote_version_id; ELSE v_id := OLD.quote_version_id; END IF;
  SELECT submitted_at INTO submitted FROM quote_versions WHERE id = v_id;
  IF submitted IS NOT NULL THEN
    RAISE EXCEPTION 'line items of submitted quote version % are immutable', v_id;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_quote_line_items_freeze ON quote_line_items;
CREATE TRIGGER trg_quote_line_items_freeze BEFORE INSERT OR UPDATE OR DELETE ON quote_line_items
  FOR EACH ROW EXECUTE FUNCTION quote_line_items_freeze();

-- 4. Ledger integrity (PRD §50) ---------------------------------------------
-- 4a. A line's currency must equal its account's currency.
CREATE OR REPLACE FUNCTION ledger_line_currency_matches() RETURNS trigger AS $$
DECLARE acct_currency char(3);
BEGIN
  SELECT currency INTO acct_currency FROM ledger_accounts WHERE id = NEW.account_id;
  IF acct_currency IS DISTINCT FROM NEW.currency THEN
    RAISE EXCEPTION 'ledger line currency % does not match account currency %', NEW.currency, acct_currency;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ledger_line_currency ON ledger_lines;
CREATE TRIGGER trg_ledger_line_currency BEFORE INSERT ON ledger_lines
  FOR EACH ROW EXECUTE FUNCTION ledger_line_currency_matches();

-- 4b. Every entry must balance (debits = credits) per currency, checked at COMMIT.
CREATE OR REPLACE FUNCTION ledger_check_balanced() RETURNS trigger AS $$
DECLARE unbalanced int;
BEGIN
  SELECT count(*) INTO unbalanced FROM (
    SELECT currency
    FROM ledger_lines
    WHERE entry_id = NEW.entry_id
    GROUP BY currency
    HAVING SUM(CASE WHEN direction = 'debit' THEN amount_minor ELSE -amount_minor END) <> 0
  ) s;
  IF unbalanced > 0 THEN
    RAISE EXCEPTION 'ledger entry % is not balanced', NEW.entry_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ledger_balanced ON ledger_lines;
CREATE CONSTRAINT TRIGGER trg_ledger_balanced AFTER INSERT ON ledger_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_check_balanced();
