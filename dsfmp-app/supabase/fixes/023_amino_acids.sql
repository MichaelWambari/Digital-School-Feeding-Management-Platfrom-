-- ============================================================
-- Fix 023: amino acids and protein quality
--
-- Protein counts how much protein a meal gives, not how good it is.
-- Maize protein is short of lysine, and beans make up for it (as in
-- githeri). This fix stores the nine essential amino acids so the
-- student report can show an amino acid score: each essential amino
-- acid per gram of protein, against the FAO reference pattern.
--
--   * food_nutrition and attendance_nutrition get the essential
--     amino acids in mg: histidine, isoleucine, leucine, lysine,
--     methionine + cysteine, phenylalanine + tyrosine, threonine,
--     tryptophan and valine (11 columns, *_mg).
--   * Values: Kenya Food Composition Tables 2018, Table 3a (mg per
--     100 g edible portion). Table 3a uses older codes than Table 1,
--     so foods are matched by name. KFCT gives methionine, cysteine
--     and tryptophan as "tr" for dry white maize and fortified maize
--     meal; those three are filled from KFCT green maize (Table 3b,
--     per g nitrogen) scaled to each food's nitrogen.
--     Oil, sugar and salt have no protein, so their amino acids are 0.
--     Foods without amino acid data (cabbage, sweet potatoes, bread,
--     green grams, lentils, millet, yellow maize) stay empty.
--   * attendance_nutrition.amino_protein_g is the protein from the
--     meal's foods that have amino acid data, so the score compares
--     like with like when some foods have no data.
--   * Amino acids aren't changed by cooking (KFCT gives no retention
--     factors for them), and missing values don't mark a meal
--     incomplete.
--   * Records already made get their amino acids worked out from the
--     servings stored in them.
--
-- The reference pattern (used by the app): FAO 2013, Dietary protein
-- quality evaluation in human nutrition, FAO Food and Nutrition Paper
-- 92, Table 5, "older child, adolescent, adult" (from age 3), mg per g
-- protein: His 16, Ile 30, Leu 61, Lys 48, Met+Cys 23, Phe+Tyr 41,
-- Thr 25, Trp 6.6, Val 40. The score isn't corrected for digestibility.
--
-- Run it in Supabase: SQL Editor > New query > paste > Run.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Columns
-- ------------------------------------------------------------
alter table food_nutrition
  add column if not exists his_mg numeric check (his_mg >= 0),
  add column if not exists ile_mg numeric check (ile_mg >= 0),
  add column if not exists leu_mg numeric check (leu_mg >= 0),
  add column if not exists lys_mg numeric check (lys_mg >= 0),
  add column if not exists met_mg numeric check (met_mg >= 0),
  add column if not exists cys_mg numeric check (cys_mg >= 0),
  add column if not exists phe_mg numeric check (phe_mg >= 0),
  add column if not exists tyr_mg numeric check (tyr_mg >= 0),
  add column if not exists thr_mg numeric check (thr_mg >= 0),
  add column if not exists trp_mg numeric check (trp_mg >= 0),
  add column if not exists val_mg numeric check (val_mg >= 0);

alter table attendance_nutrition
  add column if not exists his_mg numeric,
  add column if not exists ile_mg numeric,
  add column if not exists leu_mg numeric,
  add column if not exists lys_mg numeric,
  add column if not exists met_mg numeric,
  add column if not exists cys_mg numeric,
  add column if not exists phe_mg numeric,
  add column if not exists tyr_mg numeric,
  add column if not exists thr_mg numeric,
  add column if not exists trp_mg numeric,
  add column if not exists val_mg numeric,
  add column if not exists amino_protein_g numeric;

create or replace function public.amino_acid_keys()
returns text[] language sql immutable as $$
  select array['his_mg', 'ile_mg', 'leu_mg', 'lys_mg', 'met_mg', 'cys_mg', 'phe_mg', 'tyr_mg',
               'thr_mg', 'trp_mg', 'val_mg']
$$;

-- Every nutrient worked out for each meal, now with the amino acids.
create or replace function public.nutrient_keys()
returns text[] language sql immutable as $$
  select array['energy_kcal', 'protein_g', 'carbohydrate_g', 'fat_g', 'fibre_g',
               'calcium_mg', 'iron_mg', 'magnesium_mg', 'zinc_mg', 'vitamin_a_ug',
               'vitamin_a_re_ug', 'thiamin_mg', 'riboflavin_mg', 'niacin_mg', 'folate_ug',
               'vitamin_b12_ug', 'vitamin_c_mg', 'phytate_mg']
         || public.amino_acid_keys()
$$;

-- ------------------------------------------------------------
-- 2. Values for the shared foods (KFCT 2018 Table 3a, mg per 100 g)
-- code = the food's KFCT Table 1 code, as stored in food_nutrition
-- ------------------------------------------------------------
update food_nutrition n set
  his_mg = v.his, ile_mg = v.ile, leu_mg = v.leu, lys_mg = v.lys, met_mg = v.met, cys_mg = v.cys,
  phe_mg = v.phe, tyr_mg = v.tyr, thr_mg = v.thr, trp_mg = v.trp, val_mg = v.val
from (values
  -- code     his   ile   leu   lys   met   cys   phe   tyr   thr  trp  val
  -- Maize, white, whole grain (Table 3a "Maize, grain, white variety, whole"); Met, Cys, Trp filled
  ('01018',  214,  320, 1130,  330,  132,   94,  410,  385,  405,  46,  435),
  -- Maize flour, whole: same grain
  ('01022',  214,  320, 1130,  330,  132,   94,  410,  385,  405,  46,  435),
  -- Maize meal, sifted, fortified; Met, Cys, Trp filled
  ('01020',  310,  270, 1020,  275,  114,   81,  400,  390,  335,  39,  370),
  -- Rice, white, milled, polished
  ('01034',  166,  350,  720,  365,  192,  115,  440,  440,  294,  80,  555),
  -- Wheat flour, refined, fortified
  ('01043',  220,  370,  710,  390,  110,  150,  610,  330,  270, 100,  460),
  -- Sorghum, grain, white
  ('01039',  330,  555, 1520,  375,  173,  156,  575,  311,  450,  80,  670),
  -- Potato, Irish, peeled
  ('02009',   53,   98,  200,  190,   39,   30,  107,  125,   87,  38,  136),
  -- Beans, kidney, dry
  ('03004',  525, 1250, 2020, 1430,  271,   98, 1220,  640,  950, 190, 1490),
  -- Kale (sukuma wiki)
  ('04020',   62,  160,  250,  190,   29,   40,  220,  125,  165,  36,  220),
  -- Milk, cow, whole, fresh
  ('06022',  105,  168,  367,  303,   70,   40,  149,  182,  152,  38,  228),
  -- Beef, lean
  ('07002',  904,  926, 1630, 1780,  413,   54,  737,  594,  590, 126, 1620),
  -- Egg, chicken, whole
  ('07011',  251,  750, 1230,  669,  456,  284,  602,  473,  494, 196,  929),
  -- Dagaa (omena), dried
  ('08002', 2380, 2720, 4210, 5090, 1470,  559, 2080, 1620, 2080, 377, 3960),
  -- No protein: cooking oil, sugar, salt
  ('09013',    0,    0,    0,    0,    0,    0,    0,    0,    0,   0,    0),
  ('11003',    0,    0,    0,    0,    0,    0,    0,    0,    0,   0,    0),
  ('13027',    0,    0,    0,    0,    0,    0,    0,    0,    0,   0,    0)
) as v(code, his, ile, leu, lys, met, cys, phe, tyr, thr, trp, val)
where n.school_id is null and n.kfct_code = v.code;

-- ------------------------------------------------------------
-- 3. A school's food values, now with the amino acids
-- ------------------------------------------------------------
drop function if exists public.school_food_nutrition(uuid);
create function public.school_food_nutrition(p_school_id uuid)
returns table (food_id uuid, item_name text, unit text, energy_kcal numeric, protein_g numeric,
               carbohydrate_g numeric, fat_g numeric, fibre_g numeric, calcium_mg numeric,
               iron_mg numeric, magnesium_mg numeric, zinc_mg numeric, vitamin_a_ug numeric,
               vitamin_a_re_ug numeric, thiamin_mg numeric, riboflavin_mg numeric,
               niacin_mg numeric, folate_ug numeric, vitamin_b12_ug numeric,
               vitamin_c_mg numeric, phytate_mg numeric,
               his_mg numeric, ile_mg numeric, leu_mg numeric, lys_mg numeric, met_mg numeric,
               cys_mg numeric, phe_mg numeric, tyr_mg numeric, thr_mg numeric, trp_mg numeric,
               val_mg numeric,
               kfct_code text, source text, is_school_value boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select f.food_id, f.item_name, f.unit,
         coalesce(o.energy_kcal, d.energy_kcal), coalesce(o.protein_g, d.protein_g),
         coalesce(o.carbohydrate_g, d.carbohydrate_g), coalesce(o.fat_g, d.fat_g),
         coalesce(o.fibre_g, d.fibre_g), coalesce(o.calcium_mg, d.calcium_mg),
         coalesce(o.iron_mg, d.iron_mg), coalesce(o.magnesium_mg, d.magnesium_mg),
         coalesce(o.zinc_mg, d.zinc_mg), coalesce(o.vitamin_a_ug, d.vitamin_a_ug),
         coalesce(o.vitamin_a_re_ug, d.vitamin_a_re_ug),
         coalesce(o.thiamin_mg, d.thiamin_mg), coalesce(o.riboflavin_mg, d.riboflavin_mg),
         coalesce(o.niacin_mg, d.niacin_mg), coalesce(o.folate_ug, d.folate_ug),
         coalesce(o.vitamin_b12_ug, d.vitamin_b12_ug), coalesce(o.vitamin_c_mg, d.vitamin_c_mg),
         coalesce(o.phytate_mg, d.phytate_mg),
         coalesce(o.his_mg, d.his_mg), coalesce(o.ile_mg, d.ile_mg), coalesce(o.leu_mg, d.leu_mg),
         coalesce(o.lys_mg, d.lys_mg), coalesce(o.met_mg, d.met_mg), coalesce(o.cys_mg, d.cys_mg),
         coalesce(o.phe_mg, d.phe_mg), coalesce(o.tyr_mg, d.tyr_mg), coalesce(o.thr_mg, d.thr_mg),
         coalesce(o.trp_mg, d.trp_mg), coalesce(o.val_mg, d.val_mg),
         case when o.food_id is null then d.kfct_code end,
         coalesce(o.source, d.source), o.food_id is not null
  from food_items f
  left join food_nutrition d on d.food_id = f.food_id and d.school_id is null
  left join food_nutrition o on o.food_id = f.food_id and o.school_id = p_school_id
  where (f.school_id is null or f.school_id = p_school_id)
    -- A school's own foods and values only for its staff (or the system).
    and (auth.uid() is null or public.can_view_school(p_school_id))
  order by f.item_name;
$$;

revoke all on function public.school_food_nutrition(uuid) from public;
grant execute on function public.school_food_nutrition(uuid) to authenticated;

-- ------------------------------------------------------------
-- 4. Each student's meal record (as fix 020), plus the protein from
-- foods with amino acid data. Missing amino acids (like phytate)
-- don't mark the record incomplete.
-- ------------------------------------------------------------
-- Protein (g) from the foods in a list that have amino acid data.
create or replace function public.amino_protein(p_items jsonb)
returns numeric language sql immutable set search_path = public, pg_temp as $$
  select round(coalesce(sum(coalesce((i -> 'per_100' ->> 'protein_g')::numeric, 0)
                            * (i ->> 'amount')::numeric / 100), 0), 2)
  from jsonb_array_elements(p_items) i
  where i -> 'per_100' ->> 'lys_mg' is not null;
$$;

create or replace function public.record_attendance_nutrition()
returns trigger as $$
declare
  v_keys text[] := public.nutrient_keys();
  v_meal_id uuid;
  v_meal_name text;
  v_items jsonb;
  v_totals jsonb;
  v_complete boolean;
begin
  select ms.meal_id, m.name into v_meal_id, v_meal_name
    from meal_schedules ms join meals m on m.meal_id = ms.meal_id
    where ms.school_id = new.school_id and ms.meal_type = new.meal_type
      and ms.weekday = extract(isodow from new.attendance_date)::int;

  select coalesce(jsonb_agg(jsonb_build_object(
           'food_id', n.food_id, 'food', n.item_name, 'amount', mi.amount_per_serving,
           'unit', case when n.unit = 'litres' then 'ml' else 'g' end, 'source', n.source,
           'kfct_code', n.kfct_code,
           'per_100', (select jsonb_object_agg(k, to_jsonb(n) -> k) from unnest(v_keys) k),
           'cooking', coalesce(mi.cooking_method, f.default_cooking, 'none'),
           'retention', public.cooking_retention(coalesce(mi.cooking_method, f.default_cooking, 'none')))
           order by n.item_name), '[]'::jsonb)
    into v_items
    from meal_ingredients mi
    join food_items f on f.food_id = mi.food_id
    join public.school_food_nutrition(new.school_id) n on n.food_id = mi.food_id
    where mi.meal_id = v_meal_id;

  v_complete := v_meal_id is not null and jsonb_array_length(v_items) > 0 and not exists (
    select 1 from jsonb_array_elements(v_items) i, jsonb_each(i -> 'per_100') kv
    where kv.value = 'null'::jsonb and kv.key <> 'phytate_mg'
      and not kv.key = any (public.amino_acid_keys()));

  if v_meal_id is not null and jsonb_array_length(v_items) > 0 then
    v_totals := public.nutrition_totals(v_items)
                || jsonb_build_object('amino_protein_g', public.amino_protein(v_items));
  end if;

  insert into attendance_nutrition
  select * from jsonb_populate_record(null::attendance_nutrition,
    coalesce(v_totals, '{}'::jsonb) || jsonb_build_object(
      'attendance_id', new.attendance_id, 'beneficiary_id', new.beneficiary_id,
      'school_id', new.school_id, 'attendance_date', new.attendance_date,
      'meal_type', new.meal_type, 'meal_id', v_meal_id, 'meal_name', v_meal_name,
      'complete', v_complete, 'ingredients', v_items, 'cooked', true, 'created_at', now()))
  on conflict (attendance_id) do nothing;
  return new;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

-- ------------------------------------------------------------
-- 5. Records already made: add the amino acids per 100 g to each
-- stored food (from the school's current values) and work out the
-- totals. Amino acids have no cooking factor, so nothing else moves.
-- ------------------------------------------------------------
do $$
declare
  a attendance_nutrition%rowtype;
  v_items jsonb;
  v_totals jsonb;
begin
  for a in select * from attendance_nutrition
           where meal_name is not null and jsonb_array_length(coalesce(ingredients, '[]'::jsonb)) > 0 loop
    select jsonb_agg(i || jsonb_build_object('per_100', coalesce(i -> 'per_100', '{}'::jsonb) || aa.vals))
      into v_items
    from jsonb_array_elements(a.ingredients) i
    cross join lateral (
      select coalesce((select jsonb_object_agg(k, to_jsonb(n) -> k)
                       from public.school_food_nutrition(a.school_id) n
                       cross join unnest(public.amino_acid_keys()) k
                       where n.food_id = (i ->> 'food_id')::uuid),
                      (select jsonb_object_agg(k, null) from unnest(public.amino_acid_keys()) k)) as vals
    ) aa;

    select jsonb_object_agg(k, total) into v_totals
    from (select k, round(sum(coalesce((i -> 'per_100' ->> k)::numeric, 0)
                              * (i ->> 'amount')::numeric / 100), 2) as total
          from unnest(public.amino_acid_keys()) k cross join jsonb_array_elements(v_items) i
          group by k) t;

    update attendance_nutrition set
      ingredients = v_items,
      his_mg = (v_totals ->> 'his_mg')::numeric, ile_mg = (v_totals ->> 'ile_mg')::numeric,
      leu_mg = (v_totals ->> 'leu_mg')::numeric, lys_mg = (v_totals ->> 'lys_mg')::numeric,
      met_mg = (v_totals ->> 'met_mg')::numeric, cys_mg = (v_totals ->> 'cys_mg')::numeric,
      phe_mg = (v_totals ->> 'phe_mg')::numeric, tyr_mg = (v_totals ->> 'tyr_mg')::numeric,
      thr_mg = (v_totals ->> 'thr_mg')::numeric, trp_mg = (v_totals ->> 'trp_mg')::numeric,
      val_mg = (v_totals ->> 'val_mg')::numeric,
      amino_protein_g = public.amino_protein(v_items)
    where attendance_id = a.attendance_id;
  end loop;
end;
$$;

commit;

-- Check: the shared foods that now have amino acids.
select f.item_name, n.kfct_code, n.protein_g, n.lys_mg, n.met_mg + n.cys_mg as saa_mg, n.trp_mg
from food_nutrition n join food_items f on f.food_id = n.food_id
where n.school_id is null and n.lys_mg is not null
order by f.item_name;
