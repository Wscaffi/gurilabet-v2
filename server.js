const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

app.get('/api/jogos', async (req, res) => {
    try {
        const headers = { 'x-rapidapi-key': process.env.API_FOOTBALL_KEY };
        
        // Buscamos os próximos 60 jogos para ter bastante volume
        const resp = await axios.get('https://v3.football.api-sports.io/fixtures?next=60', { headers });

        if (!resp.data.response) return res.json([]);

        const formatados = resp.data.response.map(j => ({
            id: j.fixture.id,
            liga: j.league.name,
            logo_liga: j.league.logo,
            pais: j.league.country,
            bandeira_pais: `https://flagsapi.com/${obterCodigoPais(j.league.country)}/flat/64.png`, // Gerador de bandeiras real
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
        res.json([]);
    }
});

// Função auxiliar para converter nome do país em código de bandeira
function obterCodigoPais(nome) {
    const paises = { 
        'Brazil': 'BR', 'England': 'GB', 'Spain': 'ES', 'Italy': 'IT', 
        'Germany': 'DE', 'France': 'FR', 'Portugal': 'PT', 'Argentina': 'AR' 
    };
    return paises[nome] || 'UN'; // Retorna bandeira genérica se não mapeado
}

app.listen(process.env.PORT || 3000);
