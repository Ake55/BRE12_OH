from matplotlib.pyplot import *
from statistics import mean
import real_curves as rc

prod_tps = rc.lecture_csv('data/production_offshore_farms_within_constraint.csv', ";")
wind_YN_tps = rc.lecture_csv('data/Noirmoutier_hourly_data.csv', ",")
wind_SB_tps = rc.lecture_csv('data/Saint-Brieuc_hourly_data.csv', ",")
wind_SN_tps = rc.lecture_csv('data/Saint-Nazaire_hourly_data.csv', ",")
wind_F_tps = rc.lecture_csv('data/Fécamp_hourly_data.csv', ",")
wind_tps={'Yeu-Noirmoutier':wind_YN_tps, 'Saint-Brieuc':wind_SB_tps, 'Saint-Nazaire':wind_SN_tps, 'Fecamp':wind_F_tps}

def hourly_prod(year, parc):
    h=[]
    tps=[]
    for hour in range(24):
        tps.append(hour)
        hour='0'+str(hour) if hour<10 else str(hour)
        prod_h=[]
        for d in prod_tps:
            t=rc.extraire_cle_prod(d['timestamp'])
            t=t.split('-')
            if t[0]==year:
                th=(t[2].split(' ')[1]).split(':')[0]
                if th==hour and d[parc]!='':
                    prod_h.append(d[parc])
        if prod_h:
            h.append(mean(prod_h))
        else : 
            h.append(0)
    w=[]
    for hour in range(24):
        hour='0'+str(hour) if hour<10 else str(hour)
        wind_h=[]
        for d in wind_tps[parc]:
            t=rc.extraire_cle_wind(d['date'])
            t=t.split('-')
            if t[0]==year:
                th=(t[2].split(' ')[1]).split(':')[0]
                if th==hour and d['hourly_wind_speed_100m']!='':
                    wind_h.append(d['hourly_wind_speed_100m'])
        if wind_h:
            w.append(mean(wind_h))
        else: 
            w.append(0)
    _, ax1=subplots()
    ax1.plot(tps, h, marker='x', linestyle='-')
    ax2=ax1.twinx()
    ax2.plot(tps, w, marker='x', linestyle='-', color='red')
    title('production du parc '+parc+" par heure sur l'année "+year )
    show()
    
#hourly_prod('2025', 'Saint-Nazaire')
