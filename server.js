const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(express.json());
// Liberação total de segurança para o site conversar com o motor
app.use(cors({ origin: '*' }));

app.get('/api/jogos', async (req, res) => {
    try {
        const headers = { 'x-rapidapi-key': process.env.API_FOOTBALL_KEY };
        
        // Buscamos 50 jogos para garantir que o site fique lotado
        const resp = await axios.get('https://v3.football.api-sports.io/fixtures?next=50', { headers });

        if (!resp.data.response) throw new Error("Sem resposta da API");

        const formatados = resp.data.response.map(j => ({
            liga: j.league.name,
            logo_liga: j.league.logo,
            pais: j.league.country,
            home: { name: j.teams.home.name, logo: j.teams.home.logo },
            away: { name: j.teams.away.name, logo: j.teams.away.logo },
            placar: j.goals.home !== null ? `${j.goals.home}-${j.goals.away}` : null,
            status: j.fixture.status.short,
            data: j.fixture.date,
            odds: { 
                casa: (1.5 + Math.random()).toFixed(2), 
                empate: (3.1 + Math.random()).toFixed(2), 
                fora: (2.4 + Math.random() * 2).toFixed(2) 
            }
        }));

        res.json(formatados);
    } catch (e) {
        console.error("Erro no Motor:", e.message);
        res.status(500).json({ erro: "Falha ao carregar dados reais" });
    }
});

app.listen(process.env.PORT || 3000, () => console.log("Motor Rodando 🚀"));
