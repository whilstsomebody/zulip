import $ from "jquery";
import {z} from "zod";

import render_settings_resend_invite_modal from "../templates/confirm_dialog/confirm_resend_invite.hbs";
import render_settings_revoke_invite_modal from "../templates/confirm_dialog/confirm_revoke_invite.hbs";
import render_admin_invites_list from "../templates/settings/admin_invites_list.hbs";
import render_view_invitaion_modal from "../templates/settings/view_invitation_modal.hbs";

import * as blueslip from "./blueslip.ts";
import * as channel from "./channel.ts";
import * as confirm_dialog from "./confirm_dialog.ts";
import * as dialog_widget from "./dialog_widget.ts";
import {$t, $t_html} from "./i18n.ts";
import * as ListWidget from "./list_widget.ts";
import * as loading from "./loading.ts";
import * as people from "./people.ts";
import * as settings_config from "./settings_config.ts";
import * as settings_data from "./settings_data.ts";
import {current_user} from "./state_data.ts";
import {get_sub_by_id} from "./stream_data.ts";
import * as stream_settings_data from "./stream_settings_data.ts";
import * as timerender from "./timerender.ts";
import * as ui_report from "./ui_report.ts";
import * as util from "./util.ts";

export const invite_schema = z.intersection(
    z.object({
        invited_by_user_id: z.number(),
        invited: z.number(),
        expiry_date: z.number().nullable(),
        id: z.number(),
        invited_as: z.number(),
    }),
    z.discriminatedUnion("is_multiuse", [
        z.object({
            is_multiuse: z.literal(false),
            email: z.string(),
            notify_referrer_on_join: z.boolean(),
        }),
        z.object({
            is_multiuse: z.literal(true),
            link_url: z.string(),
        }),
    ]),
);

const extended_invite_schema = z.intersection(
    invite_schema,
    z.object({
        invited_as_text: z.string().optional(),
        invited_absolute_time: z.string().optional(),
        expiry_date_absolute_time: z.string().optional(),
        is_admin: z.boolean().optional(),
        disable_buttons: z.boolean().optional(),
        referrer_name: z.string().optional(),
        img_src: z.string().url().optional(),
        notify_referrer_on_join: z.boolean().optional(),
        stream_ids: z.array(z.number()).optional(),
        group_names: z.array(z.string()).optional(),
    }),
);

type Invite = z.infer<typeof extended_invite_schema>;

const meta = {
    loaded: false,
};

export function reset(): void {
    meta.loaded = false;
}

function failed_listing_invites(xhr: JQuery.jqXHR): void {
    loading.destroy_indicator($("#admin_page_invites_loading_indicator"));
    ui_report.error(
        $t_html({defaultMessage: "Error listing invites"}),
        xhr,
        $("#invites-field-status"),
    );
}

function failed_to_get_invite_details(xhr: JQuery.jqXHR): void {
    loading.destroy_indicator($("#admin_page_invites_loading_indicator"));
    ui_report.error(
        $t_html({defaultMessage: "Error fetching invite details."}),
        xhr,
        $("#invites-field-status"),
    );
}

function add_invited_as_text(invites: Invite[]): void {
    for (const data of invites) {
        data.invited_as_text = settings_config.user_role_map.get(data.invited_as);
    }
}

function sort_invitee(a: Invite, b: Invite): number {
    // multi-invite links don't have an email field,
    // so we set them to empty strings to let them
    // sort to the top
    const str1 = a.is_multiuse ? "" : a.email.toUpperCase();
    const str2 = b.is_multiuse ? "" : b.email.toUpperCase();

    return util.strcmp(str1, str2);
}

function populate_invites(invites_data: {invites: Invite[]}): void {
    if (!meta.loaded) {
        return;
    }

    add_invited_as_text(invites_data.invites);

    const $invites_table = $("#admin_invites_table").expectOne();
    ListWidget.create($invites_table, invites_data.invites, {
        name: "admin_invites_list",
        get_item: ListWidget.default_get_item,
        modifier_html(item) {
            item.invited_absolute_time = timerender.absolute_time(item.invited * 1000);
            if (item.expiry_date !== null) {
                item.expiry_date_absolute_time = timerender.absolute_time(item.expiry_date * 1000);
            }
            item.is_admin = current_user.is_admin;
            item.disable_buttons =
                item.invited_as === settings_config.user_role_values.owner.code &&
                !current_user.is_owner;
            item.referrer_name = people.get_by_user_id(item.invited_by_user_id).full_name;
            item.img_src = people.small_avatar_url_for_person(
                people.get_by_user_id(item.invited_by_user_id),
            );
            return render_admin_invites_list({invite: item});
        },
        filter: {
            $element: $invites_table
                .closest(".user-settings-section")
                .find<HTMLInputElement>("input.search"),
            predicate(item, value) {
                const referrer = people.get_by_user_id(item.invited_by_user_id);
                const referrer_email = referrer.email;
                const referrer_name = referrer.full_name;
                const referrer_name_matched = referrer_name.toLowerCase().includes(value);
                const referrer_email_matched = referrer_email.toLowerCase().includes(value);
                if (item.is_multiuse) {
                    return referrer_name_matched || referrer_email_matched;
                }
                const invitee_email_matched = item.email.toLowerCase().includes(value);
                return referrer_email_matched || referrer_name_matched || invitee_email_matched;
            },
        },
        $parent_container: $("#admin-invites-list").expectOne(),
        init_sort: sort_invitee,
        sort_fields: {
            invitee: sort_invitee,
            ...ListWidget.generic_sort_functions("alphabetic", ["referrer_name"]),
            ...ListWidget.generic_sort_functions("numeric", [
                "invited",
                "expiry_date",
                "invited_as",
            ]),
        },
        $simplebar_container: $("#admin-invites-list .progressive-table-wrapper"),
    });

    loading.destroy_indicator($("#admin_page_invites_loading_indicator"));
}

function get_invite_details({
    $row,
    invite_id,
    is_multiuse,
}: {
    $row: JQuery;
    invite_id: string;
    is_multiuse: string;
}): void {
    let url = "/json/invites/" + invite_id;

    if (is_multiuse === "true") {
        url = "/json/invites/multiuse/" + invite_id;
    }
    void channel.get({
        url,
        timeout: 10 * 1000,
        success(raw_data) {
            const data = z.object({invite: extended_invite_schema}).parse(raw_data);
            const invite = data.invite;
            open_invite_details_modal({$row, invite});
        },
        error: failed_to_get_invite_details,
    });
}

function open_invite_details_modal({$row, invite}: {$row: JQuery; invite: Invite}): void {
    const streams = [];

    stream_settings_data.sort_for_stream_settings(invite.stream_ids!, "by-stream-name");

    for (const stream_id of invite.stream_ids!) {
        streams.push(get_sub_by_id(stream_id));
    }
    const ctx = {
        is_multiuse: invite.is_multiuse,
        email: invite.is_multiuse ? invite.link_url : invite.email,
        invited_by_user_id: invite.invited_by_user_id,
        is_admin: current_user.is_admin,
        referrer_name: people.get_by_user_id(invite.invited_by_user_id).full_name,
        // referred_by,
        img_src: people.small_avatar_url_for_person(
            people.get_by_user_id(invite.invited_by_user_id),
        ),
        invited_at: timerender.absolute_time(invite.invited * 1000),
        invite_id: invite.id,
        expires_at: invite.expiry_date ? timerender.absolute_time(invite.expiry_date * 1000) : null,
        invited_as: settings_config.user_role_map.get(invite.invited_as),
        streams,
        groups: invite.group_names,
    };

    const html_body = render_view_invitaion_modal(ctx);
    const $modal = $(html_body);
    $("body").append($modal);

    const invite_id = invite.id.toString();
    const is_multiuse = invite.is_multiuse.toString();
    const email = ctx.email;

    $modal.find(".modal__close").on("click", () => {
        $modal.remove();
    });

    $modal.find(".revoke").on("click", () => {
        const ctx2 = {
            is_multiuse: ctx.is_multiuse,
            email: ctx.email,
            referred_by: ctx.referrer_name,
        };

        const html_body2 = render_settings_revoke_invite_modal(ctx2);

        confirm_dialog.launch({
            html_heading: ctx.is_multiuse
                ? $t_html({defaultMessage: "Revoke invitation link"})
                : $t_html({defaultMessage: "Revoke invitation to {email}"}, {email}),
            html_body: html_body2,
            on_click() {
                do_revoke_invite({$row, invite_id, is_multiuse});
                $modal.remove();
            },
        });

        $(".dialog_submit_button").attr("data-invite-id", invite_id);
        $(".dialog_submit_button").attr("data-is-multiuse", is_multiuse);
    });

    $modal.find(".resend").on("click", () => {
        const html_body2 = render_settings_resend_invite_modal({email});

        confirm_dialog.launch({
            html_heading: $t_html({defaultMessage: "Resend invitation?"}),
            html_body: html_body2,
            on_click() {
                do_resend_invite({$row, invite_id: invite.id.toString()});
                $modal.remove();
            },
        });

        $(".dialog_submit_button").attr("data-invite-id", invite_id);
    });

    $("body").on("click", ".popover-menu-link", () => {
        $modal.remove();
    });

    $(document).on("click", (e) => {
        if ($(e.target).hasClass("modal__overlay")) {
            $modal.remove();
        }
    });
}

function do_revoke_invite({
    $row,
    invite_id,
    is_multiuse,
}: {
    $row: JQuery;
    invite_id: string;
    is_multiuse: string;
}): void {
    const modal_invite_id = $(".dialog_submit_button").attr("data-invite-id");
    const modal_is_multiuse = $(".dialog_submit_button").attr("data-is-multiuse");

    if (modal_invite_id !== invite_id || modal_is_multiuse !== is_multiuse) {
        blueslip.error("Invite revoking canceled due to non-matching fields.");
        ui_report.client_error(
            $t_html({
                defaultMessage: "Error: Could not revoke invitation.",
            }),
            $("#revoke_invite_modal #dialog_error"),
        );
        dialog_widget.hide_dialog_spinner();
        return;
    }

    let url = "/json/invites/" + invite_id;

    if (modal_is_multiuse === "true") {
        url = "/json/invites/multiuse/" + invite_id;
    }
    void channel.del({
        url,
        error(xhr) {
            dialog_widget.hide_dialog_spinner();
            ui_report.error(
                $t_html({
                    defaultMessage: "Failed",
                }),
                xhr,
                $("#dialog_error"),
            );
        },
        success() {
            dialog_widget.hide_dialog_spinner();
            dialog_widget.close();
            $row.remove();
        },
    });
}

function do_resend_invite({$row, invite_id}: {$row: JQuery; invite_id: string}): void {
    const modal_invite_id = $(".dialog_submit_button").attr("data-invite-id");
    const $resend_button = $row.find("button.resend");
    const $check_button = $row.find("button.check");

    if (modal_invite_id !== invite_id) {
        blueslip.error("Invite resending canceled due to non-matching fields.");
        ui_report.client_error(
            $t_html({
                defaultMessage: "Error: Could not resend invitation.",
            }),
            $("#resend_invite_modal #dialog_error"),
        );
        dialog_widget.hide_dialog_spinner();
        return;
    }

    void channel.post({
        url: "/json/invites/" + invite_id + "/resend",
        error(xhr) {
            dialog_widget.hide_dialog_spinner();
            ui_report.error(
                $t_html({
                    defaultMessage: "Failed",
                }),
                xhr,
                $("#dialog_error"),
            );
        },
        success() {
            dialog_widget.hide_dialog_spinner();
            dialog_widget.close();

            $resend_button.hide();
            $check_button.removeClass("hide");

            // Showing a success checkmark for a short time (3 seconds).
            setTimeout(() => {
                $resend_button.show();
                $check_button.addClass("hide");
            }, 3000);
        },
    });
}

export function set_up(initialize_event_handlers = true): void {
    meta.loaded = true;

    // create loading indicators
    loading.make_indicator($("#admin_page_invites_loading_indicator"));

    // Populate invites table
    void channel.get({
        url: "/json/invites",
        timeout: 10 * 1000,
        success(raw_data) {
            const data = z.object({invites: z.array(invite_schema)}).parse(raw_data);
            on_load_success(data, initialize_event_handlers);
        },
        error: failed_listing_invites,
    });
}

export function on_load_success(
    invites_data: {invites: Invite[]},
    initialize_event_handlers: boolean,
): void {
    meta.loaded = true;
    populate_invites(invites_data);
    if (!initialize_event_handlers) {
        return;
    }
    $(".admin_invites_table").on("click", ".revoke", function (this: HTMLElement, e) {
        // This click event must not get propagated to parent container otherwise the modal
        // will not show up because of a call to `close_active` in `settings.ts`.
        e.preventDefault();
        e.stopPropagation();
        const $row = $(this).closest(".invite_row");
        const email = $row.find(".email").text();
        const referred_by = $row.find(".referred_by").text();
        const invite_id = $(this).closest("tr").attr("data-invite-id")!;
        const is_multiuse = $(this).closest("tr").attr("data-is-multiuse")!;
        const ctx = {
            is_multiuse: is_multiuse === "true",
            email,
            referred_by,
        };
        const html_body = render_settings_revoke_invite_modal(ctx);

        confirm_dialog.launch({
            html_heading: ctx.is_multiuse
                ? $t_html({defaultMessage: "Revoke invitation link"})
                : $t_html({defaultMessage: "Revoke invitation to {email}"}, {email}),
            html_body,
            id: "revoke_invite_modal",
            close_on_submit: false,
            loading_spinner: true,
            on_click() {
                do_revoke_invite({$row, invite_id, is_multiuse});
            },
        });

        $(".dialog_submit_button").attr("data-invite-id", invite_id);
        $(".dialog_submit_button").attr("data-is-multiuse", is_multiuse);
    });

    $(".admin_invites_table").on("click", ".resend", function (this: HTMLElement, e) {
        // This click event must not get propagated to parent container otherwise the modal
        // will not show up because of a call to `close_active` in `settings.ts`.
        e.preventDefault();
        e.stopPropagation();

        const $row = $(this).closest(".invite_row");
        const email = $row.find(".email").text();
        const invite_id = $(this).closest("tr").attr("data-invite-id")!;
        const html_body = render_settings_resend_invite_modal({email});

        confirm_dialog.launch({
            html_heading: $t_html({defaultMessage: "Resend invitation?"}),
            html_body,
            id: "resend_invite_modal",
            close_on_submit: false,
            loading_spinner: true,
            on_click() {
                do_resend_invite({$row, invite_id});
            },
        });

        $(".dialog_submit_button").attr("data-invite-id", invite_id);
    });

    $(".admin_invites_table").on("click", ".view_invitations", function (this: HTMLElement, e) {
        e.preventDefault();
        e.stopPropagation();

        const $row = $(this).closest(".invite_row");
        const invite_id = $(this).closest("tr").attr("data-invite-id")!;
        const is_multiuse = $(this).closest("tr").attr("data-is-multiuse")!;

        get_invite_details({$row, invite_id, is_multiuse});
    });
}

export function update_invite_users_setting_tip(): void {
    if (settings_data.user_can_invite_users_by_email()) {
        $(".invite-user-settings-tip").hide();
        return;
    }

    $(".invite-user-settings-tip").show();
    $(".invite-user-settings-tip").text(
        $t({
            defaultMessage:
                "You do not have permission to send invite emails in this organization.",
        }),
    );
}

export function update_invite_user_panel(): void {
    update_invite_users_setting_tip();
    if (
        !settings_data.user_can_invite_users_by_email() &&
        !settings_data.user_can_create_multiuse_invite()
    ) {
        $("#admin-invites-list .invite-user-link").hide();
    } else {
        $("#admin-invites-list .invite-user-link").show();
    }
}
