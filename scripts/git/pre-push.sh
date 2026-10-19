#!/bin/sh
# Refuse any push that updates or deletes refs/heads/main.
# Reads local refs from stdin: <local ref> <local sha> <remote ref> <remote sha>

while read -r local_ref _local_sha remote_ref _remote_sha; do
  if [ "$remote_ref" = "refs/heads/main" ]; then
    echo "pre-push: refusing to push directly to main. Open a pull request instead."
    exit 1
  fi
done
