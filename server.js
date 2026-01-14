const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

app.get('/api/jogos', async (req, res) => {
    try {
        const headers = { 
            'x-rapidapi-key': process.env.API_FOOTBALL_KEY,
            'x-rapidapi-host': 'v3.football.api-sports.io'
        };
        
        const hoje = new Date().toISOString().split('T')[0];
        const resp = await axios.get(`https://v3.football.api-sports.io/fixtures?date=${hoje}`, { headers, timeout: 10000 });

        let fixtures = resp.data.response;
        if (!fixtures || fixtures.length === 0) {
            const backup = await axios.get('https://v3.football.api-sports.io/fixtures?next=50', { headers });
            fixtures = backup.data.response;
        }

        res.json(formatar(fixtures));
    } catch (e) {
        res.status(500).json({ erro: e.message });
    }
});

function formatar(data) {
    return data.map(j => {
        const status = j.fixture.status.short;
        const ativo = status === 'NS'; // Apenas jogos não iniciados recebem odds
        
        return {
            id: j.fixture.id,
            liga: j.league.name,
            logo_liga: j.league.logo,
            pais: j.league.country,
            home: { name: j.teams.home.name, logo: j.teams.home.logo },
            away: { name: j.teams.away.name, logo: j.teams.away.logo },
            data: j.fixture.date,
            status: status,
            // Odds Principais (Resultado Final)
            odds: { 
                casa: ativo ? (1.5 + Math.random()).toFixed(2) : "0.00", 
                empate: ativo ? (3.0 + Math.random()).toFixed(2) : "0.00", 
                fora: ativo ? (2.2 + Math.random() * 2).toFixed(2) : "0.00" 
            },
            // MERCADOS COMPLETOS (Simulação de Casa Profissional)
            mercados: ativo ? {
                dupla_chance: {
                    casa_empate: (1.1 + Math.random() * 0.2).toFixed(2),
                    casa_fora: (1.2 + Math.random() * 0.2).toFixed(2),
                    empate_fora: (1.5 + Math.random() * 0.5).toFixed(2)
                },
                ambas_marcam: {
                    sim: (1.6 + Math.random() * 0.5).toFixed(2),
                    nao: (1.8 + Math.random() * 0.5).toFixed(2)
                },
                total_gols: {
                    mais_15: (1.2 + Math.random() * 0.3).toFixed(2),
                    menos_15: (3.5 + Math.random()).toFixed(2),
                    mais_25: (1.8 + Math.random()).toFixed(2),
                    menos_25: (1.9 + Math.random()).toFixed(2),
                    mais_35: (3.2 + Math.random()).toFixed(2),
                    menos_35: (1.3 + Math.random()).toFixed(2)
                },
                intervalo: {
                    casa_ht: (2.5 + Math.random()).toFixed(2),
                    empate_ht: (2.0 + Math.random()).toFixed(2),
                    fora_ht: (3.5 + Math.random()).toFixed(2)
                },
                placar_exato: {
                    "1-0": (6.0 + Math.random() * 2).toFixed(2),
                    "2-0": (8.5 + Math.random() * 3).toFixed(2),
                    "2-1": (9.0 + Math.random() * 3).toFixed(2),
                    "0-0": (7.5 + Math.random() * 2).toFixed(2),
                    "0-1": (8.0 + Math.random() * 3).toFixed(2)
                },
                escanteios: {
                    mais_8: (1.5 + Math.random()).toFixed(2),
                    mais_10: (2.1 + Math.random()).toFixed(2),
                    menos_10: (1.6 + Math.random()).toFixed(2)
                }
            } : null
        };
    });
}

app.listen(process.env.PORT || 3000);
