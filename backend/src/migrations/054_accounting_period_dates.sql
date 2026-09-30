-- Earlier ensurePeriod converted local midnight through UTC before storing a
-- date, which could make the last active day appear already complete.
UPDATE accounting_periods
SET starts_on = to_date(code || '-01', 'YYYY-MM-DD'),
    ends_on = (to_date(code || '-01', 'YYYY-MM-DD') + interval '1 month - 1 day')::date
WHERE (starts_on, ends_on) IS DISTINCT FROM
      (to_date(code || '-01', 'YYYY-MM-DD'),
       (to_date(code || '-01', 'YYYY-MM-DD') + interval '1 month - 1 day')::date);
