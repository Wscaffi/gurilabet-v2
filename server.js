const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

const pool = new Pool({ 
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 2000 
});

app.get('/api/jogos', async (req, res) => {
    try {
        // Busca jogos reais das próximas 48 horas
        const resp = await axios.get('https://v3.football.api-sports.io/fixtures?next=50', {
            headers: { 
                'x-rapidapi-key': process.env.API_FOOTBALL_KEY,
                'x-rapidapi-host': 'v3.football.api-sports.io'
            }
        });

        const jogos = resp.data.response.map(j => ({
            id: j.fixture.id,
            liga: j.league.name,
            bandeira: j.league.logo,
            home: { name: j.teams.home.name, logo: j.teams.home.logo },
            away: { name: j.teams.away.name, logo: j.teams.away.logo },
            data: j.fixture.date,
            odds: { 
                casa: (1.4 + Math.random()).toFixed(2), 
                empate: (3.2 + Math.random()).toFixed(2), 
                fora: (2.5 + Math.random()).toFixed(2) 
            }
        }));
        res.json(jogos);
    } catch (error) {
        res.json([]); // Retorna vazio se a API falhar, mas não derruba o site
    }
});

app.listen(process.env.PORT || 3000);
