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
        
        // Busca direta para garantir volume de jogos
        const resp = await axios.get('https://v3.football.api-sports.io/fixtures?next=50', { headers });

        if (!resp.data.response || resp.data.response.length === 0) {
            return res.json([]);
        }

        const formatados = resp.data.response.map(j => ({
            id: j.fixture.id,
            liga: j.league.name,
            pais: j.league.country,
            bandeira: j.league.logo, // Usa o logo da liga como identificador visual
            home: { name: j.teams.home.name, logo: j.teams.home.logo },
            away: { name: j.teams.away.name, logo: j.teams.away.logo },
            data: j.fixture.date,
            odds: { 
                casa: (1.5 + Math.random()).toFixed(2), 
                empate: (3.1 + Math.random()).toFixed(2), 
                fora: (2.4 + Math.random() * 2).toFixed(2) 
            }
        }));

        res.json(formatados);
    } catch (e) {
        console.error("Erro Crítico:", e.message);
        res.status(500).json([]);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Motor Gurila Bet na porta ${PORT}`));
