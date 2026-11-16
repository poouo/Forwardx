#!/bin/bash
# run the API client inside the panel container
docker cp -q /root/fxtest/. fxt-panel:/tmp/fxtest/ && docker exec -i -w /tmp/fxtest fxt-panel node "$@"
