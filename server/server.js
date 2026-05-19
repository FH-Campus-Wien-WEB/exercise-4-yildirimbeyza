const express = require("express");
const path = require("path");
const bodyParser = require("body-parser");
const session = require("express-session");
const bcrypt = require("bcrypt");
const config = require("./config.js");
const movieModel = require("./movie-model.js");
const userModel = require("./user-model.js");

const app = express();

// Parse urlencoded bodies
app.use(bodyParser.json());

// Session middleware
app.use(session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false } // Set to true if using HTTPS
}));

// Serve static content in directory 'files'
app.use(express.static(path.join(__dirname, "files")));

app.post("/login", function (req, res) {
    const { username, password } = req.body;
    const user = userModel[username];
    if (user && bcrypt.compareSync(password, user.password)) {
        req.session.user = {
            username,
            firstName: user.firstName,
            lastName: user.lastName,
            loginTime: new Date().toISOString(),
        };
        res.send(req.session.user);
    } else {
        res.sendStatus(401);
    }
});

// Task 1.3: requireLogin middleware — checks session, sends 401 if missing
function requireLogin(req, res, next) {
    if (req.session && req.session.user) {
        next();
    } else {
        res.sendStatus(401);
    }
}

// Task 1.3: GET /logout — destroy session with error handling
app.get("/logout", function (req, res) {
    req.session.destroy(function (err) {
        if (err) {
            res.sendStatus(500);
        } else {
            res.sendStatus(200);
        }
    });
});

app.get("/session", function (req, res) {
    if (req.session.user) {
        res.send(req.session.user);
    } else {
        res.status(401).json(null);
    }
});

// Task 1.3: All endpoints below are protected with requireLogin
app.get("/movies", requireLogin, function (req, res) {
    const username = req.session.user.username;
    let movies = Object.values(movieModel.getUserMovies(username));
    const queriedGenre = req.query.genre;
    if (queriedGenre) {
        movies = movies.filter((movie) => movie.Genres.indexOf(queriedGenre) >= 0);
    }
    res.send(movies);
});

app.get("/movies/:imdbID", requireLogin, function (req, res) {
    const username = req.session.user.username;
    const id = req.params.imdbID;
    const movie = movieModel.getUserMovie(username, id);

    if (movie) {
        res.send(movie);
    } else {
        res.sendStatus(404);
    }
});

app.put("/movies/:imdbID", requireLogin, function (req, res) {
    const username = req.session.user.username;
    const imdbID = req.params.imdbID;
    const exists = movieModel.getUserMovie(username, imdbID) !== undefined;

    if (!exists) {
        // Task 2.3: Fetch full movie data from OMDb, convert to internal format, save it
        const url = `http://www.omdbapi.com/?i=${encodeURIComponent(imdbID)}&plot=full&apikey=${config.omdbApiKey}`;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), config.omdbTimeoutMs);

        fetch(url, { signal: controller.signal })
            .then(apiRes => {
                clearTimeout(timeoutId);
                if (!apiRes.ok) {
                    return res.sendStatus(apiRes.status);
                }
                return apiRes.text().then(data => {
                    let omdb;
                    try {
                        omdb = JSON.parse(data);
                    } catch (parseError) {
                        console.error('Failed to parse OMDb response:', parseError);
                        return res.sendStatus(500);
                    }

                    if (omdb.Response !== 'True') {
                        return res.sendStatus(404);
                    }

                    // Convert OMDb format to internal movie format
                    const movie = {
                        imdbID: omdb.imdbID,
                        Title: omdb.Title,
                        Released: formatReleasedDate(omdb.Released),
                        Runtime: parseInt(omdb.Runtime) || 0,
                        Genres: omdb.Genre ? omdb.Genre.split(', ') : [],
                        Directors: omdb.Director ? omdb.Director.split(', ') : [],
                        Writers: omdb.Writer ? omdb.Writer.split(', ') : [],
                        Actors: omdb.Actors ? omdb.Actors.split(', ') : [],
                        Plot: omdb.Plot || '',
                        Poster: omdb.Poster || '',
                        Metascore: parseFloat(omdb.Metascore) || 0,
                        imdbRating: parseFloat(omdb.imdbRating) || 0
                    };

                    movieModel.setUserMovie(username, imdbID, movie);
                    res.status(201).send(movie);
                });
            })
            .catch(err => {
                clearTimeout(timeoutId);
                if (err.name === 'AbortError') {
                    console.error('OMDb API request timeout');
                    return res.sendStatus(504);
                }
                console.error('OMDb API error:', err);
                res.sendStatus(500);
            });
    } else {
        movieModel.setUserMovie(username, imdbID, req.body);
        res.sendStatus(200);
    }
});

app.delete("/movies/:imdbID", requireLogin, function (req, res) {
    const username = req.session.user.username;
    const id = req.params.imdbID;
    if (movieModel.deleteUserMovie(username, id)) {
        res.sendStatus(200);
    } else {
        res.sendStatus(404);
    }
});

app.get("/genres", requireLogin, function (req, res) {
    const username = req.session.user.username;
    const genres = movieModel.getGenres(username);
    genres.sort();
    res.send(genres);
});

app.get("/search", requireLogin, function (req, res) {
    const username = req.session.user.username;
    const query = req.query.query;
    if (!query) {
        return res.sendStatus(400);
    }

    const url = `http://www.omdbapi.com/?s=${encodeURIComponent(query)}&apikey=${config.omdbApiKey}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.omdbTimeoutMs);

    fetch(url, { signal: controller.signal })
        .then(apiRes => {
            clearTimeout(timeoutId);
            if (!apiRes.ok) {
                return res.sendStatus(apiRes.status);
            }
            return apiRes.text().then(data => {
                let response;
                try {
                    response = JSON.parse(data);
                } catch (parseError) {
                    console.error('Failed to parse OMDb response:', parseError);
                    return res.sendStatus(500);
                }

                if (response.Response === 'True') {
                    const results = response.Search
                        .filter(movie => !movieModel.hasUserMovie(username, movie.imdbID))
                        .map(movie => ({
                            Title: movie.Title,
                            imdbID: movie.imdbID,
                            Year: isNaN(movie.Year) ? null : parseInt(movie.Year)
                        }));
                    res.send(results);
                } else {
                    res.send([]);
                }
            });
        })
        .catch((err) => {
            clearTimeout(timeoutId);
            if (err.name === 'AbortError') {
                console.error('OMDb API request timeout');
                return res.sendStatus(504);
            }
            console.error('OMDb API error:', err);
            res.sendStatus(500);
        });
});

app.listen(config.port);

console.log(`Server now listening on http://localhost:${config.port}/`);

// ── Helper ─────────────────────────────────────────────────────────────────────

/**
 * OMDb returns dates like "15 Sep 2005". Convert to ISO "2005-09-15".
 */
function formatReleasedDate(dateStr) {
    if (!dateStr || dateStr === 'N/A') return '';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '';
    return d.toISOString().split('T')[0];
}