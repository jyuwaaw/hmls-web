-- Fix: handle_new_user() never set customers.shop_id, which 0031 made NOT NULL.
-- A brand-new email has no existing customer to link, so the trigger takes the
-- INSERT branch and violates the not-null constraint. That rolls back the
-- auth.users INSERT, so exchangeCodeForSession() errors and the OAuth /
-- magic-link callback redirects to /login?error=Could not authenticate for
-- EVERY new signup. Existing users hit the UPDATE branch and were unaffected.
--
-- Stamp new customers with the primary shop (san-jose), falling back to the
-- oldest shop so the trigger can never null-fail while any shop exists. The
-- order flow re-routes shop_id by geocoded address at order time, so this is
-- only the initial home-shop default.

CREATE OR REPLACE FUNCTION public.handle_new_user()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
DECLARE
  _name TEXT;
  _phone TEXT;
  _email TEXT;
  _shop_id uuid;
BEGIN
  _email := NEW.email;
  _name := NEW.raw_user_meta_data ->> 'full_name';
  IF _name IS NULL THEN
    _name := NEW.raw_user_meta_data ->> 'name';
  END IF;
  _phone := NEW.raw_user_meta_data ->> 'phone';

  -- Try to match an existing customer by email and link
  UPDATE public.customers
  SET auth_user_id = NEW.id::text
  WHERE email = _email
    AND auth_user_id IS NULL;

  -- If no existing customer was linked, create a new one (stamped with a shop).
  IF NOT FOUND THEN
    SELECT COALESCE(
      (SELECT id FROM public.shops WHERE slug = 'san-jose'),
      (SELECT id FROM public.shops ORDER BY created_at LIMIT 1)
    ) INTO _shop_id;

    INSERT INTO public.customers (name, email, phone, auth_user_id, shop_id)
    VALUES (_name, _email, _phone, NEW.id::text, _shop_id);
  END IF;

  RETURN NEW;
END;
$function$;
