# Lovebird (web app)

The published web files of Lovebird, a private calendar, chat, calls and walkie-talkie for couples.
Everything private is end-to-end encrypted on the phones before it is sent to Supabase.
The key in `config.js` is Supabase's *publishable* key, which is meant to be public;
Row Level Security decides what each signed-in person may read or write.
