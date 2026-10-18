from matplotlib.pyplot import *
from statistics import mean
import real_curves as rc

prod_tps = rc.lecture_csv('data/production_offshore_farms_within_constraint.csv', ";")

def month_prod(year, parc):
    m=[]
    tps=[]
    for month in range(12):
        tps.append(month+1)
        month='0'+str(month+1) if month<9 else str(month+1)
        prod_m=[]
        for d in prod_tps:
            t=rc.extraire_cle_prod(d['timestamp'])
            t=t.split('-')
            if t[0]==year:
                if t[1]==month and d[parc]!='':
                    prod_m.append(d[parc])
        if prod_m:
            m.append(mean(prod_m))
        else : 
            m.append(0)
    title('production du parc '+parc+" par mois sur l'année "+year )
    plot(tps, m, marker='x', linestyle='-')
    show()
    
#month_prod('2025', 'Saint-Nazaire')
