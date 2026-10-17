import real_curves.py as rc

data_communes=rc.lecture_csv('data/donnees_communes.csv', ';')
pop_par_commune={}
for c in data_communes:
  pop_par_commune[c['Commune']]=c[PTOT]

prod_tps = rc.lecture_csv('data/production_offshore_farms_within_constraint.csv', ";")
conso_par_hab_jour=3.6*2223/365

def conso(commune, parc, time_old:str='2025-01-01', time_new:str='2026-01-01'):
  prod_laps=[]
  test=False
  nj=0
  for d in prod_tps:
    t=rc.extraire_cle_prod(d['timestamp'])
    t=t.split(' ')[0]
    if t==time_old:
      test=True
    elif t==tim_new:
      test=False
    if test:
      prod_laps.append(d[parc])
      nj+=1
  prod_tot=0 #prod_tot : production énergétique totale sur le laps de temps décrit, en MJ
  for p in prod_laps:
    prod_tot+=p*3600
  return (prod_tot/(nj*conso_par_hab_jour))*100
