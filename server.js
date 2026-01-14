const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

// Conexão protegida para não dar "Crashed"
const pool = new Pool({ 
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

app.get('/api/jogos', async (req, res) => {
    try {
        // Busca 30 jogos reais com escudos
        const resp = await axios.get('https://v3.football.api-sports.io/fixtures?next=30', {
            headers: { 
                'x-rapidapi-key': process.env.API_FOOTBALL_KEY,
                'x-rapidapi-host': 'v3.football.api-sports.io'
            }
        });

        const jogos = resp.data.response.map(j => ({
            id: j.fixture.id,
            liga: j.league.name,
            home: { name: j.teams.home.name, logo: j.teams.home.logo },
            away: { name: j.teams.away.name, logo: j.teams.away.logo },
            data: j.fixture.date,
            odds: { 
                casa: (1.5 + Math.random()).toFixed(2), 
                empate: (3.1 + Math.random()).toFixed(2), 
                fora: (2.4 + Math.random()).toFixed(2) 
            }
        }));
        res.json(jogos);
    } catch (error) {
        // Backup para o site nunca ficar preto
        res.json([{
            liga: "Principais Ligas",
            home: {name: "Manchester City", logo: "https://media.api-sports.io/football/teams/50.png"},
            away: {name: "Real Madrid", logo: "https://media.api-sports.io/football/teams/541.png"},
            data: new Date().toISOString(),
            odds: {casa: "2.10", empate: "3.40", fora: "3.80"}
        }]);
    }
});

app.post('/api/finalizar', async (req, res) => {
    const { valor, palpite, times, odd } = req.body;
    const codigo = "GB" + Math.floor(Math.random() * 999999);
    const retorno = (valor * odd).toFixed(2);
    try {
        await pool.query('INSERT INTO bilhetes (codigo, valor, retorno, times, palpite) VALUES ($1, $2, $3, $4, $5)', [codigo, valor, retorno, times, palpite]);
    } catch (e) { console.log("Aposta gerada offline"); }
    res.json({ codigo, retorno });
});

app.listen(process.env.PORT || 3000);
