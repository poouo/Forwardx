tail -n "${2:-25}" "./$1.log" | cut -c1-230
