const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

app.get('/api/jogos', async (req, res) => {
    try {
        const headers = { 'x-rapidapi-key': process.env.API_FOOTBALL_KEY };
        
        // Busca direta por volume para garantir que os jogos apareçam
        const resp = await axios.get('https://v3.football.api-sports.io/fixtures?next=50', { headers });

        const formatados = resp.data.response.map(j => ({
            id: j.fixture.id,
            liga: j.league.name,
            pais: j.league.country,
            bandeira: j.league.logo, // Logo da liga como bandeira principal
            home: { name: j.teams.home.name, logo: j.teams.home.logo },
            away: { name: j.teams.away.name, logo: j.teams.away.logo },
            data: j.fixture.date,
            odds: { casa: "1.80", empate: "3.30", fora: "4.50" }
        }));

        res.json(formatados);
    } catch (e) {
        res.json([]);
    }
});

app.listen(process.env.PORT || 3000);
