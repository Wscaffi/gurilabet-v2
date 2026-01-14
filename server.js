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
        const podeApostar = j.fixture.status.short === 'NS'; // NS = Not Started
        return {
            id: j.fixture.id,
            liga: j.league.name,
            logo_liga: j.league.logo,
            pais: j.league.country,
            home: { name: j.teams.home.name, logo: j.teams.home.logo },
            away: { name: j.teams.away.name, logo: j.teams.away.logo },
            data: j.fixture.date,
            status: j.fixture.status.short,
            odds: { 
                casa: podeApostar ? (1.5 + Math.random()).toFixed(2) : "0.00", 
                empate: podeApostar ? (3.0 + Math.random()).toFixed(2) : "0.00", 
                fora: podeApostar ? (2.2 + Math.random() * 2).toFixed(2) : "0.00" 
            },
            // Acrescentado: Inteligência de mercados secundários
            mercados_extras: podeApostar ? {
                gols: { mais: (1.7 + Math.random()).toFixed(2), menos: (1.8 + Math.random()).toFixed(2) },
                ambas: { sim: (1.6 + Math.random()).toFixed(2), nao: (1.9 + Math.random()).toFixed(2) }
            } : null
        };
    });
}

app.listen(process.env.PORT || 3000);
