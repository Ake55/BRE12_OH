import real_curves as rc

data_communes=rc.lecture_csv('data/donnees_communes.csv', ';')
pop_par_commune={}
for c in data_communes:
  pop_par_commune[c['Commune']]=c['PTOT']

prod_tps = rc.lecture_csv('data/production_offshore_farms_within_constraint.csv', ";")
conso_par_hab_jour=2.223/365

def conso(commune, parc, time_old:str='2025-01-01', time_new:str='2026-01-01'):
  prod_laps=[]
  test=False
  nj=0
  for d in prod_tps:
    t=rc.extraire_cle_prod(d['timestamp'])
    t=t.split(' ')[0]
    if t==time_old:
      test=True
    elif t==time_new:
      test=False
    if test:
      prod_laps.append(d[parc])
      nj+=1
  prod_r=[p for p in prod_laps if p!='']
  nj=nj/24
  prod_tot=0 #prod_tot : production énergétique totale sur le laps de temps décrit, en MJ
  for p in prod_r:
    prod_tot+=p
  return (prod_tot/(nj*conso_par_hab_jour*pop_par_commune[commune]))

print(conso('Toulouse', 'Saint-Nazaire'))