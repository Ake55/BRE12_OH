import real_curves.py as rc

data_communes=rc.lecture_csv('data/donnees_communes.csv', ';')
pop_par_commune={}
for c in data_communes:
  pop_par_commune[c['Commune']]=c[PTOT]

prod_tps = rc.lecture_csv('data/production_offshore_farms_within_constraint.csv', ";")
wind_YN_tps = rc.lecture_csv('data/Noirmoutier_hourly_data.csv', ",")
wind_SB_tps = rc.lecture_csv('data/Saint-Brieuc_hourly_data.csv', ",")
wind_SN_tps = rc.lecture_csv('data/Saint-Nazaire_hourly_data.csv', ",")
wind_F_tps = rc.lecture_csv('data/Fécamp_hourly_data.csv', ",")
wind_tps={'Yeu-Noirmoutier':wind_YN_tps, 'Saint-Brieuc':wind_SB_tps, 'Saint-Nazaire':wind_SN_tps, 'Fecamp':wind_F_tps}

def conso(commune, parc, time_old:str='2025-01-01', time_new:str='2026-01-01'):
  prod_laps=[]
  test=False
  for d in prod_tps:
    t=rc.extraire_cle_prod(d['timestamp'])
    t=t.split(' ')[0]
    if t==time_old:
      test=True
    elif t==tim_new:
      test=False
    if test:
      prod_laps.append(d)

  wind_laps=[]
  for d in wind_tps[parc]:
    t=rc.extraire_cle_wind(d['timestamp'])
    t=t.split(' ')[0]
    if t==time_old:
      test=True
    elif t==tim_new:
      test=False
    if test:
      wind_laps.append(d)
      
  wind_speed = {}
  prod_r = {}
  
  wind_speed, prod_r = rc.apparier(prod_laps, 'timestamp', parc, wind_laps) 
