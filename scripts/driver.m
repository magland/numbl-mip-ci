% mip-ci driver: run the full mip lifecycle for one package inside a single
% numbl process and emit machine-readable markers on stdout.
%
%   @@STEP_BEGIN <step>
%   @@STEP_END <step> status=ok ms=<n>
%   @@STEP_END <step> status=fail ms=<n> id=<errId> msg=<single-line message>
%   @@STEP_SKIP <step> reason=<why>
%   @@ALL_DONE
%
% The package name is taken from the MIP_TEST_PACKAGE environment variable.
% If the install step fails, the remaining steps are skipped (there is
% nothing installed to load, test, or uninstall).

pkg = getenv('MIP_TEST_PACKAGE');
channel = 'mip-org/core';
steps = {'install', 'load', 'test', 'unload', 'uninstall'};

installFailed = false;

for i = 1:numel(steps)
    s = steps{i};

    if installFailed
        fprintf('@@STEP_SKIP %s reason=install_failed\n', s);
        continue
    end

    fprintf('@@STEP_BEGIN %s\n', s);
    t0 = tic;
    ok = true;
    eid = '';
    emsg = '';
    try
        switch s
            case 'install'
                mip('install', '--channel', channel, pkg);
            case 'load'
                mip('load', pkg);
            case 'test'
                mip('test', pkg);
            case 'unload'
                mip('unload', pkg);
            case 'uninstall'
                mip('uninstall', pkg);
        end
    catch ME
        ok = false;
        eid = ME.identifier;
        emsg = strrep(ME.message, sprintf('\n'), ' | ');
    end
    ms = round(toc(t0) * 1000);
    if ok
        fprintf('@@STEP_END %s status=ok ms=%d\n', s, ms);
    else
        fprintf('@@STEP_END %s status=fail ms=%d id=%s msg=%s\n', s, ms, eid, emsg);
        if strcmp(s, 'install')
            installFailed = true;
        end
    end
end

fprintf('@@ALL_DONE\n');
