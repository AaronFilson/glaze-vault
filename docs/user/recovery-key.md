# Your recovery key

Your recovery key is 24 words, shown once when you set up your vault. It is a second key to
your vault, as strong as your password and a great deal harder to guess.

## Keeping it safe

- **Anyone with the sheet can open your vault,** so keep it as you would keep a spare key: in a
  locked drawer or a safe, not taped to the monitor.
- **Keep it away from the computer.** If the computer is stolen, the sheet should not go with it.
- **Do not lose it.** If you lose both your password and your recovery key, your recipes cannot
  be recovered by anyone. That is the point of the encryption: there is no back door.

## Using your recovery key

1. On the unlock screen, choose **Forgot your password?**
2. Type the 24 words in order. Capitals, extra spaces and line breaks do not matter. The count
   below the box shows how many words you have typed.
3. Type a new password twice, and choose **Set password and unlock**.

If a word is mistyped, Glaze Vault says the recovery key is not right before trying it: the last
word is a checksum of the others. Check each word against your sheet.

Your recovery key does not change when you use it, so keep the same sheet.

## Making a new recovery key

If your sheet is lost, or someone else may have seen it, make a new one: open **Settings**, type
your password under **Recovery key**, and choose **Make a new recovery key**. Glaze Vault shows
the new words, offers to print them, and checks three of them, as when you set up.

The old sheet stops opening this vault straight away. It still opens
[backups](backups.md) made before, because a backup opens with what opened the vault the day it
was made. So after making a new recovery key, make a new backup, and destroy older backups you
no longer need.
