import { expect } from 'chai';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as sinon from 'sinon';

import { git } from '../src/git';
import { LinkHandler } from '../src/link-handler';
import { HandlerDefinition, ReverseSettings } from '../src/schema';
import { Settings } from '../src/settings';
import { LinkOptions, LinkType, RepositoryWithRemote, UrlInfo } from '../src/types';
import { isErrorCode } from '../src/utilities';

import { Directory, markAsSlow, setupRepository } from './helpers';

describe('LinkHandler', function () {
    let repository: RepositoryWithRemote;
    let root: Directory;

    // We need to create repositories, so mark the
    // tests as being a bit slower than other tests.
    markAsSlow(this);

    beforeEach(async () => {
        root = await Directory.create();

        repository = {
            root: root.path,
            remote: 'http://example.com'
        };
    });

    afterEach(async () => {
        sinon.restore();
        await root.dispose();
    });

    describe('createUrl', () => {
        it('should use the default link type if no type was specified.', async () => {
            let getDefaultLinkType: sinon.SinonStub<[], LinkType>;

            await setupRepository(root.path);

            getDefaultLinkType = sinon.stub(Settings.prototype, 'getDefaultLinkType');

            getDefaultLinkType.returns('commit');
            expect(await createUrl({ url: '{{ type }}' }, { type: undefined })).to.equal('commit');

            getDefaultLinkType.returns('branch');
            expect(await createUrl({ url: '{{ type }}' }, { type: undefined })).to.equal('branch');
        });

        it('should use the commit hash as the "ref" value when the link type is "commit".', async () => {
            await setupRepository(root.path);

            expect(await createUrl({ url: '{{ ref }}' }, { type: 'commit' })).to.equal(
                (await git(root.path, 'rev-parse', 'HEAD')).trim()
            );
        });

        it('should use the branch name as the "ref" value when the link type is "branch".', async () => {
            await setupRepository(root.path);

            await git(root.path, 'checkout', '-b', 'foo');

            expect(
                await createUrl(
                    {
                        url: '{{ ref }}',
                        branch: ['rev-parse', '--abbrev-ref']
                    },
                    { type: 'branch' }
                )
            ).to.equal('foo');
        });

        it('should use the default branch name as the "ref" value when the link type is "defaultBranch".', async () => {
            sinon.stub(Settings.prototype, 'getDefaultBranch').returns('bar');

            await setupRepository(root.path);

            expect(await createUrl({ url: '{{ ref }}' }, { type: 'defaultBranch' })).to.equal(
                'bar'
            );
        });

        it('should handle the matching server address ending with a slash.', async () => {
            repository = { ...repository, remote: 'http://example.com/foo/bar' };

            await setupRepository(root.path);

            expect(
                await createUrl(
                    {
                        server: { http: 'http://example.com/', ssh: '' },
                        url: '{{ base }} | {{ repository }}'
                    },
                    {}
                )
            ).to.equal('http://example.com | foo/bar');
        });

        it('should handle the matching server address not ending with a slash.', async () => {
            repository = { ...repository, remote: 'http://example.com/foo/bar' };

            await setupRepository(root.path);

            expect(
                await createUrl(
                    {
                        server: { http: 'http://example.com/', ssh: '' },
                        url: '{{ base }} | {{ repository }}'
                    },
                    {}
                )
            ).to.equal('http://example.com | foo/bar');
        });

        it('should handle the matching server address not ending with a colon.', async () => {
            repository = { ...repository, remote: 'ssh://git@example.com:foo/bar' };

            await setupRepository(root.path);

            expect(
                await createUrl(
                    {
                        server: { http: 'http://example.com/', ssh: 'ssh://git@example.com' },
                        url: '{{ base }} | {{ repository }}'
                    },
                    {}
                )
            ).to.equal('http://example.com | foo/bar');
        });

        it('should handle the matching server address ending with a colon.', async () => {
            repository = { ...repository, remote: 'ssh://git@example.com:foo/bar' };

            await setupRepository(root.path);

            expect(
                await createUrl(
                    {
                        server: { http: 'http://example.com/', ssh: 'ssh://git@example.com:' },
                        url: '{{ base }} | {{ repository }}'
                    },
                    {}
                )
            ).to.equal('http://example.com | foo/bar');
        });

        it('should trim ".git" from the end of the repository path.', async () => {
            repository = { ...repository, remote: 'http://example.com/foo/bar.git' };

            await setupRepository(root.path);

            expect(
                await createUrl(
                    {
                        server: { http: 'http://example.com', ssh: '' },
                        url: '{{ base }} | {{ repository }}'
                    },
                    {}
                )
            ).to.equal('http://example.com | foo/bar');
        });

        it('should handle SSH URL with a protocol.', async () => {
            repository = { ...repository, remote: 'git@example.com:foo/bar' };

            await setupRepository(root.path);

            expect(
                await createUrl(
                    {
                        server: { http: 'http://example.com/', ssh: 'ssh://git@example.com' },
                        url: '{{ base }}'
                    },
                    {}
                )
            ).to.equal('http://example.com');
        });

        it('should handle SSH URL without a protocol.', async () => {
            repository = { ...repository, remote: 'git@example.com:foo/bar' };

            await setupRepository(root.path);

            expect(
                await createUrl(
                    {
                        server: { http: 'http://example.com/', ssh: 'git@example.com' },
                        url: '{{ base }}'
                    },
                    {}
                )
            ).to.equal('http://example.com');
        });

        it('should handle SSH with "git@".', async () => {
            repository = { ...repository, remote: 'git@example.com:foo/bar' };

            await setupRepository(root.path);

            expect(
                await createUrl(
                    {
                        server: { http: 'http://example.com/', ssh: 'git@example.com' },
                        url: '{{ base }}'
                    },
                    {}
                )
            ).to.equal('http://example.com');
        });

        it('should handle SSH without "git@".', async () => {
            repository = { ...repository, remote: 'git@example.com:foo/bar' };

            await setupRepository(root.path);

            expect(
                await createUrl(
                    {
                        server: { http: 'http://example.com/', ssh: 'example.com' },
                        url: '{{ base }}'
                    },
                    {}
                )
            ).to.equal('http://example.com');
        });

        it(`should use the real path for files under a directory that is a symbolic link.`, async function () {
            let real: string;
            let link: string;

            await setupRepository(root.path);

            real = await root.mkdirp('real');
            link = path.join(root.path, 'link');

            if (!(await tryCreateSymlink(real, link, 'dir'))) {
                return this.skip();
            }

            await fs.writeFile(path.join(real, 'foo.js'), '');

            expect(
                await createUrl(
                    { url: '{{ base }}/{{ file }}' },
                    { type: 'branch' },
                    path.join(link, 'foo.js')
                )
            ).to.equal('http://example.com/real/foo.js');
        });

        it(`should use the real path for a file that is a symbolic link.`, async function () {
            let real: string;
            let link: string;
            let foo: string;

            await setupRepository(root.path);

            real = await root.mkdirp('real');

            foo = path.join(real, 'foo.js');
            await fs.writeFile(foo, '');

            link = path.join(root.path, 'link.js');

            if (!(await tryCreateSymlink(foo, link, 'file'))) {
                return this.skip();
            }

            expect(
                await createUrl({ url: '{{ base }}/{{ file }}' }, { type: 'branch' }, link)
            ).to.equal('http://example.com/real/foo.js');
        });

        it('should not use the real path when the entire Git repository is under a symbolic link.', async function () {
            let real: string;
            let link: string;
            let foo: string;

            real = await root.mkdirp('repo');
            await setupRepository(real);

            link = path.join(root.path, 'link');

            if (!(await tryCreateSymlink(real, link, 'dir'))) {
                return this.skip();
            }

            repository = {
                root: link,
                remote: 'http://example.com'
            };

            foo = path.join(real, 'foo.js');
            await fs.writeFile(foo, '');

            expect(
                await createUrl(
                    { url: '{{ base }}/{{ file }}' },
                    { type: 'branch' },
                    path.join(link, 'foo.js')
                )
            ).to.equal('http://example.com/foo.js');
        });

        async function createUrl(
            definition: Partial<HandlerDefinition>,
            options: Partial<LinkOptions>,
            filePath: string = 'file.txt'
        ): Promise<string> {
            return await createHandler(definition).createUrl(
                repository,
                { filePath, selection: undefined },
                { type: 'commit', ...options }
            );
        }

        function createHandler(definition: Partial<HandlerDefinition>): LinkHandler {
            return new LinkHandler({
                name: 'Test',
                server: { http: 'http://example.com', ssh: 'ssh://example.com' },
                branch: ['rev-parse'],
                url: '',
                selection: '',
                ...definition,
                reverse: {
                    pattern: '',
                    file: '',
                    server: { http: '', ssh: '' },
                    selection: { startLine: '', endLine: '' }
                }
            });
        }

        async function tryCreateSymlink(
            target: string,
            symlinkPath: string,
            type: string
        ): Promise<boolean> {
            try {
                await fs.symlink(target, symlinkPath, type);
                return true;
            } catch (ex) {
                if (isErrorCode(ex, 'EPERM')) {
                    // Creating symlinks on Windows requires administrator permissions.
                    // We'll return false so that the test can be skipped.
                    console.warn('Unable to create symlink. Permission denied.'); // eslint-disable-line no-console
                    return false;
                } else {
                    throw ex;
                }
            }
        }
    });

    describe('getUrlInfo', () => {
        it('should return undefined in strict mode when the URL does not match the server.', () => {
            expect(getUrlInfo({ pattern: '.+' }, 'http://different.com/foo/bar.txt', true)).to.be
                .undefined;
        });

        it('should return undefined when the pattern does not match the URL in strict mode.', () => {
            expect(getUrlInfo({ pattern: '^https://.+' }, 'http://example.com/foo/bar.txt', true))
                .to.be.undefined;
        });

        it('should return undefined when the pattern does not match the URL in non-strict mode.', () => {
            expect(getUrlInfo({ pattern: '^https://.+' }, 'http://example.com/foo/bar.txt', false))
                .to.be.undefined;
        });

        it('should return the info when the pattern matches the URL.', () => {
            expect(
                getUrlInfo(
                    {
                        pattern: 'http://example\\.com/[^/]+/(?<file>.+)',
                        file: '{{ match.groups.file }}',
                        server: { http: 'http', ssh: 'ssh' },
                        selection: {
                            startLine: '10',
                            startColumn: '20',
                            endLine: '30',
                            endColumn: '40'
                        }
                    },
                    'http://example.com/foo/bar.txt',
                    false
                )
            ).to.deep.equal({
                filePath: 'bar.txt',
                server: { http: 'http', ssh: 'ssh' },
                selection: {
                    startLine: 10,
                    startColumn: 20,
                    endLine: 30,
                    endColumn: 40
                }
            });
        });

        it('should handle invalid selection properties.', () => {
            expect(
                getUrlInfo(
                    {
                        pattern: 'http://example\\.com/[^/]+/(?<file>.+)',
                        file: '{{ match.groups.file }}',
                        server: { http: 'http', ssh: 'ssh' },
                        selection: {
                            startLine: '10',
                            startColumn: 'x',
                            endLine: ''
                        }
                    },
                    'http://example.com/foo/bar.txt',
                    false
                )?.selection
            ).to.deep.equal({
                startLine: 10,
                startColumn: undefined,
                endLine: undefined,
                endColumn: undefined
            });
        });

        it('should provide the matching server info to the templates.', () => {
            expect(
                getUrlInfo(
                    {
                        pattern: 'http://example\\.com/.+',
                        server: { http: '{{ http }}', ssh: '{{ ssh }}' }
                    },
                    'http://example.com/foo/bar.txt',
                    false
                )?.server
            ).to.deep.equal({
                http: 'http://example.com',
                ssh: 'example.com'
            });
        });

        function getUrlInfo(
            settings: Partial<ReverseSettings>,
            url: string,
            strict: boolean
        ): UrlInfo | undefined {
            return createHandler(settings).getUrlInfo(url, strict);
        }

        function createHandler(reverse: Partial<ReverseSettings>): LinkHandler {
            return new LinkHandler({
                name: 'Test',
                server: { http: 'http://example.com', ssh: 'ssh://example.com' },
                branch: ['rev-parse'],
                url: '',
                selection: '',
                reverse: {
                    pattern: '',
                    file: '',
                    server: { http: '', ssh: '' },
                    selection: { startLine: '', endLine: '' },
                    ...reverse
                }
            });
        }
    });
});
