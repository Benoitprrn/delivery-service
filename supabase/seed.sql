-- Données de test Phase 1 — UUID fixes, réutilisés comme "IDs hardcodés"
-- par les endpoints tant qu'il n'y a pas d'auth JWT (Phase 2+).

insert into zones (id, name, center_lat, center_lng, radius_km) values
  ('11111111-1111-1111-1111-111111111111', 'Bourg-en-Bresse', 46.2058, 5.2255, 10.0);

insert into merchants (id, name, zone_id, address, phone, lat, lng) values
  ('22222222-2222-2222-2222-222222222222', 'Restaurant Le Terminus',
   '11111111-1111-1111-1111-111111111111',
   'Place de la Grenette, 01000 Bourg-en-Bresse', '04 74 00 00 00', 46.2058, 5.2255);

insert into drivers (id, name, zone_id, is_available) values
  ('33333333-3333-3333-3333-333333333333', 'Jean-Paul',
   '11111111-1111-1111-1111-111111111111', true);
