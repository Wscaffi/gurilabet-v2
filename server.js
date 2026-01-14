const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

app.get('/api/jogos', async (req, res) => {
    try {
        const headers = { 'x-rapidapi-key': process.env.API_FOOTBALL_KEY };
        
        // Pegamos a data de hoje no formato YYYY-MM-DD
        const hoje = new Date().toISOString().split('T')[0];
        
        // Buscamos jogos do dia atual (Hoje)
        const resp = await axios.get(`https://v3.football.api-sports.io/fixtures?date=${hoje}`, { headers });

        if (!resp.data.response || resp.data.response.length === 0) {
            // Plano B: Se por algum motivo a data falhar, pegamos os próximos 50 gerais
            const backup = await axios.get('https://v3.football.api-sports.io/fixtures?next=50', { headers });
            return res.json(formatar(backup.data.response));
        }

        res.json(formatar(resp.data.response));
    } catch (e) {
        res.status(500).json({ erro: e.message });
    }
});

// Função para organizar os dados sem repetir código
function formatar(data) {
    return data.map(j => ({
        liga: j.league.name,
        logo_liga: j.league.logo,
        pais: j.league.country,
        home: { name: j.teams.home.name, logo: j.teams.home.logo },
        away: { name: j.teams.away.name, logo: j.teams.away.logo },
        data: j.fixture.date,
        status: j.fixture.status.short,
        odds: { 
            casa: (1.5 + Math.random()).toFixed(2), 
            empate: (3.0 + Math.random()).toFixed(2), 
            fora: (2.2 + Math.random() * 2).toFixed(2) 
        }
    }));
}

app.listen(process.env.PORT || 3000);
